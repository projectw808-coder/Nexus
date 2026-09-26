/**
 * The integration proof for ADR-022 decision 4: stage 6's existing per-`TimelineEvent` loop now
 * also fans the same event out to customer webhook subscriptions, and the delivery really is
 * POSTed with a signature the customer can verify — all the way through the queue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '@nexus/config';
import {
  MemoryBudgetStore,
  RateLimiter,
  generateMasterKeyBase64,
  localKeyProvider,
  type FetchLike,
  type Logger,
} from '@nexus/connector-sdk';
import { TRIGGER_TYPES } from '@nexus/automation';
import {
  createSubscription,
  createVault,
  listDeliveries,
  systemActorFor,
  upsertConnection,
  verifySignatureHeader,
  type Actor,
} from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus, type InlineBus } from './bus.ts';
import type { SyncDeps } from './deps.ts';
import { enqueueAutomationEventsForObjects } from './react.ts';
import { createConnectorRegistry } from './registry.ts';
import { countingSink } from './sink.ts';
import {
  PUBLIC_EVENT_FOR_TRIGGER,
  deliverOutboundWebhookJob,
  outboundWebhookData,
  publicEventFor,
} from './outbound-webhooks.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const vault = createVault({
  keyProvider: localKeyProvider({
    masterKeyId: 'local:test',
    masterKeyBase64: generateMasterKeyBase64(),
  }),
});

let db: TestDatabase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
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

function makeDeps(fetch: FetchLike): { deps: SyncDeps; bus: InlineBus } {
  const holder: { deps: SyncDeps | null } = { deps: null };
  const bus = createInlineBus({
    handlers: {
      [QUEUES.automate]: async () => undefined,
      [QUEUES.outboundWebhook]: (job) =>
        deliverOutboundWebhookJob(holder.deps!, job.data, {
          fetch,
          retry: { baseMs: 1, capMs: 2 },
        }),
    },
    retry: { baseMs: 1, capMs: 2 },
  });
  const deps: SyncDeps = {
    runtime: db.runtime,
    vault,
    limiter: new RateLimiter({ store: new MemoryBudgetStore() }),
    registry: createConnectorRegistry(),
    bus,
    logger: quiet,
    sink: countingSink(),
    appSecrets: {
      webhookSecret: () => null,
      oauthCredentials: async () => ({ clientId: 'c', clientSecret: 's' }),
      stateSecret: () => 'state',
    },
    appUrl: 'https://app.nexus.test',
  };
  holder.deps = deps;
  return { deps, bus };
}

async function seed(): Promise<{ actor: Actor; workspaceId: string; connectionId: string }> {
  seq += 1;
  const owner = await db.prisma.user.create({ data: { email: `owh-s${seq}@t.com`, name: 'O' } });
  const ws = await db.tenancy.createWorkspace({
    name: `Hooks ${seq}`,
    slug: `hooks-sync-${seq}`,
    ownerUserId: owner.id,
  });
  const actor = systemActorFor(ws.id);
  const connectionId = await db.runtime.withTenant(actor, (tx) =>
    upsertConnection(tx, {
      workspaceId: ws.id,
      platform: 'INSTAGRAM',
      label: 'IG',
      accountExternalId: `acct_${seq}`,
      accountName: 'IG',
      scopesGranted: [],
      scopesRequired: [],
      capabilities: [],
      apiVersion: '2026-09',
      tokenRef: 'tok_test',
      tokenExpiresAt: null,
      ownerUserId: owner.id,
    }).then((c) => c.id),
  );
  return { actor, workspaceId: ws.id, connectionId };
}

describe('the public event vocabulary', () => {
  it('maps every internal trigger type explicitly, namespacing the conversation events', () => {
    for (const trigger of TRIGGER_TYPES)
      expect(Object.hasOwn(PUBLIC_EVENT_FOR_TRIGGER, trigger)).toBe(true);
    expect(publicEventFor('record.created')).toBe('record.created');
    expect(publicEventFor('message.received')).toBe('conversation.message.received');
    expect(publicEventFor('comment.received')).toBe('conversation.comment.received');
    expect(publicEventFor('mention.received')).toBe('conversation.mention.received');
    // Internal-only triggers are not exposed, and never create a delivery.
    expect(publicEventFor('schedule')).toBeNull();
    expect(publicEventFor('webhook.inbound')).toBeNull();
  });

  it('flattens ids and payload into the delivered data object, dropping nulls', () => {
    const data = outboundWebhookData({
      workspaceId: 'w',
      type: 'record.created',
      occurredAt: '2026-09-26T10:00:00.000Z',
      recordId: 'rec-1',
      listId: null,
      payload: { values: { name: 'Ada' } },
    });
    expect(data).toEqual({
      occurredAt: '2026-09-26T10:00:00.000Z',
      recordId: 'rec-1',
      values: { name: 'Ada' },
    });
  });
});

describe('stage 6 → outbound webhooks', () => {
  it('delivers a signed POST for a newly materialized inbound comment', async () => {
    const { actor, workspaceId, connectionId } = await seed();
    const { secretPlaintext } = await db.runtime.withTenant(actor, (tx) =>
      createSubscription(tx, actor, vault, {
        url: 'https://hooks.example.test/stage6',
        events: ['conversation.comment.received'],
      }),
    );
    const ext = await db.runtime.withTenant(actor, (tx) =>
      tx.externalObject.create({
        data: {
          workspaceId,
          connectionId,
          platform: 'INSTAGRAM',
          kind: 'comment',
          externalId: `ext_${seq}`,
          raw: {},
          contentHash: 'hash',
          apiVersion: '1',
          fetchedAt: new Date(),
        },
      }),
    );
    await db.runtime.withTenant(actor, (tx) =>
      tx.timelineEvent.create({
        data: {
          workspaceId,
          type: 'COMMENT',
          platform: 'INSTAGRAM',
          connectionId,
          occurredAt: new Date(),
          summary: 'commented',
          externalObjectId: ext.id,
          dedupeKey: `t:${ext.externalId}`,
          payload: { direction: 'inbound', body: 'what is the price?' },
        },
      }),
    );

    const endpoint = mockEndpoint();
    const { deps, bus } = makeDeps(endpoint.fetch);
    const { enqueued } = await enqueueAutomationEventsForObjects(deps, {
      workspaceId,
      connectionId,
      objectIds: [ext.id],
    });
    expect(enqueued).toBe(1);
    await bus.drain();

    expect(endpoint.requests).toHaveLength(1);
    const request = endpoint.requests[0]!;
    expect(request.headers['x-nexus-event']).toBe('conversation.comment.received');
    expect(
      verifySignatureHeader(
        secretPlaintext,
        request.body,
        request.headers['x-nexus-signature'] as string,
      ),
    ).toBe(true);
    const body = JSON.parse(request.body) as { event: string; data: Record<string, unknown> };
    expect(body.event).toBe('conversation.comment.received');
    expect(body.data['body']).toBe('what is the price?');
    expect(body.data['timelineEventId']).toBeTypeOf('string');

    const deliveries = await db.runtime.withTenant(actor, (tx) => listDeliveries(tx, {}));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('DELIVERED');
    expect(deliveries[0]!.responseStatus).toBe(200);
  });

  it('creates nothing when no subscription wants the event', async () => {
    const { actor, workspaceId, connectionId } = await seed();
    await db.runtime.withTenant(actor, (tx) =>
      createSubscription(tx, actor, vault, {
        url: 'https://hooks.example.test/records-only',
        events: ['record.created'],
      }),
    );
    const ext = await db.runtime.withTenant(actor, (tx) =>
      tx.externalObject.create({
        data: {
          workspaceId,
          connectionId,
          platform: 'INSTAGRAM',
          kind: 'comment',
          externalId: `ext_none_${seq}`,
          raw: {},
          contentHash: 'hash',
          apiVersion: '1',
          fetchedAt: new Date(),
        },
      }),
    );
    await db.runtime.withTenant(actor, (tx) =>
      tx.timelineEvent.create({
        data: {
          workspaceId,
          type: 'COMMENT',
          connectionId,
          occurredAt: new Date(),
          summary: 'commented',
          externalObjectId: ext.id,
          dedupeKey: `t:${ext.externalId}`,
          payload: { direction: 'inbound', body: 'hi' },
        },
      }),
    );
    const endpoint = mockEndpoint();
    const { deps, bus } = makeDeps(endpoint.fetch);
    await enqueueAutomationEventsForObjects(deps, {
      workspaceId,
      connectionId,
      objectIds: [ext.id],
    });
    await bus.drain();
    expect(endpoint.requests).toHaveLength(0);
    expect(await db.runtime.withTenant(actor, (tx) => listDeliveries(tx, {}))).toHaveLength(0);
  });
});
