/**
 * Outbound webhooks (§11.2): the signature format a customer verifies, subscription CRUD with a
 * show-once signing secret, the delivery path end to end against a mock endpoint, the
 * retry-then-dead-letter chain, and replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  generateMasterKeyBase64,
  localKeyProvider,
  type FetchLike,
} from '@nexus/connector-sdk';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { systemActorFor } from '../sync/connections.ts';
import { createVault, type Vault } from '../vault.ts';
import type { Actor } from '../scoped.ts';
import { dispatchOutboundWebhookEvent, type PendingOutboundDelivery } from './events.ts';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  parseSignatureHeader,
  signPayload,
  signatureHeaderValue,
  verifySignature,
  verifySignatureHeader,
} from './signing.ts';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from './subscriptions.ts';
import {
  RESPONSE_BODY_LIMIT,
  getDelivery,
  listDeliveries,
  replayDelivery,
  runOutboundWebhookDelivery,
  sweepDueOutboundDeliveries,
  type DeliveryDeps,
} from './deliveries.ts';

let db: TestDatabase;
let vault: Vault;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  vault = createVault({
    keyProvider: localKeyProvider({
      masterKeyId: 'local:test',
      masterKeyBase64: generateMasterKeyBase64(),
    }),
  });
});
afterAll(async () => {
  await db.close();
});

async function seedWorkspace(): Promise<Actor> {
  seq += 1;
  const owner = await db.prisma.user.create({ data: { email: `owh${seq}@t.com`, name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({
    name: `Hooks ${seq}`,
    slug: `hooks-${seq}`,
    ownerUserId: owner.id,
  });
  return { ...systemActorFor(ws.id), userId: owner.id, actorType: 'USER' };
}

/** A mock customer endpoint: records every request, answers with a scripted queue of statuses. */
function mockEndpoint(statuses: number[] | (() => number)) {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, headers, body: init.body as string });
    const status = typeof statuses === 'function' ? statuses() : (statuses[i++] ?? 200);
    return new Response(status === 204 ? null : 'ok', { status });
  };
  return { requests, fetch };
}

const deliveryDeps = (fetch: FetchLike): DeliveryDeps => ({
  runtime: db.runtime,
  vault,
  fetch,
  // Tiny backoff: the test asserts the policy is applied, not that it waits a real minute.
  retry: { baseMs: 1, capMs: 2 },
});

async function subscribe(actor: Actor, events: string[], url = 'https://hooks.example.test/nexus') {
  return db.runtime.withTenant(actor, (tx) =>
    createSubscription(tx, actor, vault, { url, events, description: 'test endpoint' }),
  );
}

async function dispatch(
  actor: Actor,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<PendingOutboundDelivery[]> {
  const enqueued: PendingOutboundDelivery[] = [];
  await db.runtime.withTenant(actor, (tx) =>
    dispatchOutboundWebhookEvent(
      tx,
      async (d) => {
        enqueued.push(d);
      },
      { workspaceId: actor.workspaceId, eventType: eventType as never, payload },
    ),
  );
  return enqueued;
}

describe('signing', () => {
  it('round-trips, and rejects a tampered body, timestamp or secret', () => {
    const secret = 'whsec_test-secret';
    const body = JSON.stringify({ id: 'd1', event: 'record.created', data: { n: 1 } });
    const t = 1_800_000_000;
    const header = signatureHeaderValue(secret, t, body);

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const parsed = parseSignatureHeader(header)!;
    expect(parsed.timestamp).toBe(t);
    expect(verifySignature(secret, t, body, parsed.v1[0]!)).toBe(true);

    // A tampered body, a moved timestamp and the wrong secret each fail.
    expect(verifySignature(secret, t, `${body} `, parsed.v1[0]!)).toBe(false);
    expect(verifySignature(secret, t + 1, body, parsed.v1[0]!)).toBe(false);
    expect(verifySignature('whsec_other', t, body, parsed.v1[0]!)).toBe(false);
    // ...and so does a signature over the body alone, i.e. the timestamp really is signed.
    expect(verifySignature(secret, t, body, signPayload(secret, '', body))).toBe(false);
  });

  it('enforces the replay window in the header check', () => {
    const secret = 'whsec_window';
    const body = '{"a":1}';
    const now = new Date('2026-09-26T12:00:00Z');
    const fresh = signatureHeaderValue(secret, Math.floor(now.getTime() / 1000), body);
    expect(verifySignatureHeader(secret, body, fresh, { now: () => now })).toBe(true);
    const later = new Date(now.getTime() + 10 * 60_000);
    expect(verifySignatureHeader(secret, body, fresh, { now: () => later })).toBe(false);
    expect(verifySignatureHeader(secret, body, null)).toBe(false);
    expect(verifySignatureHeader(secret, body, 'garbage')).toBe(false);
  });
});

describe('subscriptions', () => {
  it('returns the signing secret exactly once and never stores it on the row', async () => {
    const actor = await seedWorkspace();
    const { subscription, secretPlaintext } = await subscribe(actor, ['record.created']);
    expect(secretPlaintext.startsWith('whsec_')).toBe(true);

    const rows = await db.runtime.withTenant(actor, (tx) => listSubscriptions(tx));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secretPlaintext);
    // Nothing on the subscription row is the secret; only a vault handle is.
    const raw = await db.runtime.withSystem((tx) =>
      tx.outboundWebhookSubscription.findFirstOrThrow({ where: { id: subscription.id } }),
    );
    expect(raw.secretRef).not.toBe(secretPlaintext);
    expect(JSON.stringify(raw)).not.toContain(secretPlaintext);
    // The delivery path can still read it back, and it is the same secret.
    const fromVault = await db.runtime.withTenant(actor, (tx) => vault.get(tx, raw.secretRef));
    expect(fromVault.secret).toBe(secretPlaintext);
    expect(fromVault.kind).toBe('SIGNING_SECRET');
  });

  it('validates the url and the event names, and soft-deletes', async () => {
    const actor = await seedWorkspace();
    await expect(subscribe(actor, ['record.created'], 'http://example.com/x')).rejects.toThrow(
      /https/i,
    );
    await expect(subscribe(actor, ['record.created'], 'https://localhost/x')).rejects.toThrow(
      /not reachable/i,
    );
    await expect(subscribe(actor, ['nope.exploded'])).rejects.toThrow(/Unknown webhook event/i);

    const { subscription } = await subscribe(actor, ['record.created']);
    await db.runtime.withTenant(actor, (tx) =>
      updateSubscription(tx, subscription.id, { enabled: false, events: ['record.updated'] }),
    );
    const [updated] = await db.runtime.withTenant(actor, (tx) => listSubscriptions(tx));
    expect(updated!.enabled).toBe(false);
    expect(updated!.events).toEqual(['record.updated']);

    await db.runtime.withTenant(actor, (tx) => deleteSubscription(tx, vault, subscription.id));
    expect(await db.runtime.withTenant(actor, (tx) => listSubscriptions(tx))).toHaveLength(0);
    const raw = await db.runtime.withSystem((tx) =>
      tx.outboundWebhookSubscription.findFirstOrThrow({ where: { id: subscription.id } }),
    );
    expect(raw.deletedAt).not.toBeNull();
  });
});

describe('dispatch', () => {
  it('creates one delivery per matching enabled subscription, and is idempotent', async () => {
    const actor = await seedWorkspace();
    const wanted = await subscribe(actor, ['record.created', 'record.updated']);
    const other = await subscribe(actor, ['list.entry_added'], 'https://hooks.example.test/b');
    const disabled = await subscribe(actor, ['record.created'], 'https://hooks.example.test/c');
    await db.runtime.withTenant(actor, (tx) =>
      updateSubscription(tx, disabled.subscription.id, { enabled: false }),
    );

    const payload = { recordId: 'rec-1', occurredAt: '2026-09-26T10:00:00.000Z' };
    const first = await dispatch(actor, 'record.created', payload);
    expect(first).toHaveLength(1);
    expect(first[0]!.subscriptionId).toBe(wanted.subscription.id);

    // The same event again — key order shuffled — collapses onto the same delivery row.
    const again = await dispatch(actor, 'record.created', {
      occurredAt: payload.occurredAt,
      recordId: payload.recordId,
    });
    expect(again).toHaveLength(0);
    const rows = await db.runtime.withTenant(actor, (tx) => listDeliveries(tx, {}));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    expect(other.subscription.id).not.toBe(rows[0]!.subscriptionId);
  });
});

describe('delivery', () => {
  it('signs the POST in the documented format and marks it DELIVERED', async () => {
    const actor = await seedWorkspace();
    const { subscription, secretPlaintext } = await subscribe(actor, ['record.created']);
    const [pending] = await dispatch(actor, 'record.created', { recordId: 'rec-42', n: 1 });
    const endpoint = mockEndpoint([200]);

    const outcome = await runOutboundWebhookDelivery(deliveryDeps(endpoint.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    expect(outcome.status).toBe('DELIVERED');
    expect(outcome.attempts).toBe(1);

    expect(endpoint.requests).toHaveLength(1);
    const request = endpoint.requests[0]!;
    expect(request.url).toBe(subscription.url);
    expect(request.headers[EVENT_HEADER.toLowerCase()]).toBe('record.created');
    expect(request.headers[DELIVERY_HEADER.toLowerCase()]).toBe(pending!.deliveryId);
    expect(request.headers['x-nexus-attempt']).toBe('1');

    // The signature is real: a customer with the secret verifies it, and only that secret does.
    const header = request.headers[SIGNATURE_HEADER.toLowerCase()]!;
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignatureHeader(secretPlaintext, request.body, header)).toBe(true);
    expect(verifySignatureHeader('whsec_wrong', request.body, header)).toBe(false);

    const body = JSON.parse(request.body) as {
      id: string;
      event: string;
      workspaceId: string;
      data: Record<string, unknown>;
    };
    expect(body.id).toBe(pending!.deliveryId);
    expect(body.event).toBe('record.created');
    expect(body.workspaceId).toBe(actor.workspaceId);
    expect(body.data['recordId']).toBe('rec-42');

    const stored = await db.runtime.withTenant(actor, (tx) => getDelivery(tx, pending!.deliveryId));
    expect(stored!.status).toBe('DELIVERED');
    expect(stored!.responseStatus).toBe(200);
    expect(stored!.deliveredAt).not.toBeNull();
  });

  it('truncates a huge response body', async () => {
    const actor = await seedWorkspace();
    await subscribe(actor, ['record.created']);
    const [pending] = await dispatch(actor, 'record.created', { recordId: 'big' });
    const fetch: FetchLike = async () => new Response('x'.repeat(200_000), { status: 200 });
    await runOutboundWebhookDelivery(deliveryDeps(fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    const stored = await db.runtime.withTenant(actor, (tx) => getDelivery(tx, pending!.deliveryId));
    expect(stored!.responseBody!.length).toBeLessThanOrEqual(RESPONSE_BODY_LIMIT + 1);
  });

  it('retries a 500 and dead-letters after MAX_ATTEMPTS, then a replay succeeds', async () => {
    const actor = await seedWorkspace();
    await subscribe(actor, ['record.created']);
    const [pending] = await dispatch(actor, 'record.created', { recordId: 'rec-flaky' });
    const failing = mockEndpoint(() => 500);
    const deps = deliveryDeps(failing.fetch);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const outcome = await runOutboundWebhookDelivery(deps, {
        workspaceId: actor.workspaceId,
        deliveryId: pending!.deliveryId,
      });
      expect(outcome.status).toBe('FAILED');
      expect(outcome.attempts).toBe(attempt);
      expect(outcome.retry).not.toBeNull();
      expect(outcome.retry!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() - 1_000);
    }
    const last = await runOutboundWebhookDelivery(deps, {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    expect(last.status).toBe('DEAD_LETTERED');
    expect(last.attempts).toBe(MAX_ATTEMPTS);
    expect(last.retry).toBeNull();
    expect(failing.requests).toHaveLength(MAX_ATTEMPTS);

    // Replay resets the row in place and the next attempt (now to a healthy endpoint) succeeds.
    const replayed = await db.runtime.withTenant(actor, (tx) =>
      replayDelivery(tx, actor, pending!.deliveryId),
    );
    expect(replayed.attempts).toBe(0);
    const afterReplay = await db.runtime.withTenant(actor, (tx) =>
      getDelivery(tx, pending!.deliveryId),
    );
    expect(afterReplay!.status).toBe('PENDING');

    const healthy = mockEndpoint([202]);
    const redelivered = await runOutboundWebhookDelivery(deliveryDeps(healthy.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    expect(redelivered.status).toBe('DELIVERED');
    expect(redelivered.attempts).toBe(1);
    expect(healthy.requests).toHaveLength(1);
  });

  it('does not retry a 4xx the endpoint means, and never re-sends a delivered event', async () => {
    const actor = await seedWorkspace();
    await subscribe(actor, ['record.created']);
    const [rejected] = await dispatch(actor, 'record.created', { recordId: 'rec-bad' });
    const endpoint = mockEndpoint([400]);
    const outcome = await runOutboundWebhookDelivery(deliveryDeps(endpoint.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: rejected!.deliveryId,
    });
    expect(outcome.status).toBe('DEAD_LETTERED');
    expect(outcome.attempts).toBe(1);

    const [ok] = await dispatch(actor, 'record.created', { recordId: 'rec-ok' });
    const good = mockEndpoint([200, 200]);
    const deps = deliveryDeps(good.fetch);
    await runOutboundWebhookDelivery(deps, {
      workspaceId: actor.workspaceId,
      deliveryId: ok!.deliveryId,
    });
    const second = await runOutboundWebhookDelivery(deps, {
      workspaceId: actor.workspaceId,
      deliveryId: ok!.deliveryId,
    });
    expect(second.status).toBe('SKIPPED');
    expect(good.requests).toHaveLength(1);
  });

  it('dead-letters a delivery whose subscription was paused, without POSTing', async () => {
    const actor = await seedWorkspace();
    const { subscription } = await subscribe(actor, ['record.created']);
    const [pending] = await dispatch(actor, 'record.created', { recordId: 'rec-paused' });
    await db.runtime.withTenant(actor, (tx) =>
      updateSubscription(tx, subscription.id, { enabled: false }),
    );
    const endpoint = mockEndpoint([200]);
    const outcome = await runOutboundWebhookDelivery(deliveryDeps(endpoint.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    expect(outcome.status).toBe('DEAD_LETTERED');
    expect(endpoint.requests).toHaveLength(0);
  });
});

describe('the due-delivery sweep', () => {
  it('re-surfaces a delivery whose retry is due, and drops it once delivered', async () => {
    const actor = await seedWorkspace();
    await subscribe(actor, ['record.created'], 'https://hooks.example.test/sweep');
    const [pending] = await dispatch(actor, 'record.created', { recordId: 'rec-sweep' });
    const failing = mockEndpoint([500]);
    const failed = await runOutboundWebhookDelivery(deliveryDeps(failing.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    expect(failed.status).toBe('FAILED');

    const due = await sweepDueOutboundDeliveries(db.runtime, {
      now: new Date(Date.now() + 60_000),
    });
    expect(due.map((d) => d.deliveryId)).toContain(pending!.deliveryId);
    expect(due.find((d) => d.deliveryId === pending!.deliveryId)!.attempts).toBe(1);

    const healthy = mockEndpoint([200]);
    await runOutboundWebhookDelivery(deliveryDeps(healthy.fetch), {
      workspaceId: actor.workspaceId,
      deliveryId: pending!.deliveryId,
    });
    const afterDelivery = await sweepDueOutboundDeliveries(db.runtime, {
      now: new Date(Date.now() + 60_000),
    });
    expect(afterDelivery.map((d) => d.deliveryId)).not.toContain(pending!.deliveryId);
  });
});
