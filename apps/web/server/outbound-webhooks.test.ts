/**
 * Outbound webhooks through the tRPC surface (§11.2, ADR-022 decision 4): the show-once signing
 * secret, the permission boundary, and the end-to-end proof — subscribe to `record.created`,
 * create a record the normal way, and the delivery is enqueued from the record router's own call
 * site and POSTed with a verifiable signature.
 */
import type { FetchLike } from '@nexus/connector-sdk';
import { QUEUES } from '@nexus/config';
import { verifySignatureHeader } from '@nexus/db';
import { deliverOutboundWebhookJob } from '@nexus/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWorkspaces, type Seed } from './testing';

let seed: Seed;
let owner: ReturnType<Seed['caller']>;
let viewer: ReturnType<Seed['caller']>;

beforeAll(async () => {
  seed = await seedWorkspaces();
  owner = seed.caller(seed.users.alice, 'acme');
  viewer = seed.caller(seed.users.carol, 'acme');
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

function mockEndpoint() {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body as string,
    });
    return new Response('ok', { status: 200 });
  };
  return { requests, fetch };
}

describe('outbound webhook subscriptions', () => {
  it('shows the signing secret once and never again, and hides everything from a viewer', async () => {
    const created = await owner.outboundWebhook.create({
      url: 'https://hooks.example.test/acme',
      events: ['record.created'],
      description: 'CI',
    });
    expect(created.secretPlaintext).toMatch(/^whsec_/);

    const listed = await owner.outboundWebhook.list();
    const row = listed.find((s) => s.id === created.subscription.id)!;
    expect(JSON.stringify(row)).not.toContain(created.secretPlaintext);
    expect(Object.keys(row)).not.toContain('secretRef');

    await expect(viewer.outboundWebhook.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      viewer.outboundWebhook.create({
        url: 'https://x.example.test/y',
        events: ['record.created'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Rotation mints a different secret, also shown once.
    const rotated = await owner.outboundWebhook.rotateSecret({ id: created.subscription.id });
    expect(rotated.secretPlaintext).not.toBe(created.secretPlaintext);
    await owner.outboundWebhook.delete({ id: created.subscription.id });
  });

  it('delivers a record.created event raised by the normal record mutation', async () => {
    const { subscription, secretPlaintext } = await owner.outboundWebhook.create({
      url: 'https://hooks.example.test/records',
      events: ['record.created'],
    });
    const before = seed.sync.bus.calls.length;

    const person = await owner.person.create({ values: { name: 'Ada Lovelace' } });

    const jobs = seed.sync.bus.calls
      .slice(before)
      .filter((c) => c.queue === QUEUES.outboundWebhook);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!.data as { workspaceId: string; deliveryId: string; eventType: string };
    expect(job.eventType).toBe('record.created');

    const deliveries = await owner.outboundWebhook.deliveries({ subscriptionId: subscription.id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('PENDING');

    const endpoint = mockEndpoint();
    const outcome = await deliverOutboundWebhookJob(seed.sync, job, {
      fetch: endpoint.fetch,
      retry: { baseMs: 1, capMs: 2 },
    });
    expect(outcome.status).toBe('DELIVERED');
    expect(endpoint.requests).toHaveLength(1);
    const request = endpoint.requests[0]!;
    expect(request.headers['x-nexus-event']).toBe('record.created');
    expect(
      verifySignatureHeader(
        secretPlaintext,
        request.body,
        request.headers['x-nexus-signature'] as string,
      ),
    ).toBe(true);
    const body = JSON.parse(request.body) as { data: Record<string, unknown> };
    expect(body.data['recordId']).toBe(person.id);
    expect(body.data['objectTypeApiSlug']).toBe('person');

    const after = await owner.outboundWebhook.deliveries({ subscriptionId: subscription.id });
    expect(after[0]!.status).toBe('DELIVERED');

    // Replay resets the row in place and re-enqueues it.
    const replayed = await owner.outboundWebhook.replay({ id: after[0]!.id });
    expect(replayed.id).toBe(after[0]!.id);
    const reset = await owner.outboundWebhook.delivery({ id: after[0]!.id });
    expect(reset.status).toBe('PENDING');
    expect(reset.attempts).toBe(0);
    await owner.outboundWebhook.delete({ id: subscription.id });
  });
});
