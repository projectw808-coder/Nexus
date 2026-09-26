/**
 * Stage 6 (§4.1 "React"): a freshly-materialized inbound comment enqueues an `AutomationEvent`
 * onto `QUEUES.automate`, an outbound echo does not, and an object with no timeline event at all
 * enqueues nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '@nexus/config';
import { MemoryBudgetStore, RateLimiter, type Logger } from '@nexus/connector-sdk';
import { systemActorFor, upsertConnection, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus, type ActiveJob, type InlineBus } from './bus.ts';
import type { SyncDeps } from './deps.ts';
import { createConnectorRegistry } from './registry.ts';
import { enqueueAutomationEventsForObjects } from './react.ts';
import { countingSink } from './sink.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDatabase;
let wsSeq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

function makeDeps(captured: ActiveJob[]): { deps: SyncDeps; bus: InlineBus } {
  const bus = createInlineBus({
    handlers: {
      [QUEUES.automate]: async (job) => {
        captured.push(job);
      },
    },
  });
  const deps: SyncDeps = {
    runtime: db.runtime,
    vault: undefined as never,
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
  return { deps, bus };
}

async function seed(): Promise<{ actor: Actor; workspaceId: string; connectionId: string }> {
  wsSeq += 1;
  const owner = await db.prisma.user.create({ data: { email: `o${wsSeq}@t.com`, name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({
    name: `Acme ${wsSeq}`,
    slug: `acme-react-${wsSeq}`,
    ownerUserId: owner.id,
  });
  const actor = systemActorFor(ws.id);
  const connectionId = await db.runtime.withTenant(actor, (tx) =>
    upsertConnection(tx, {
      workspaceId: ws.id,
      platform: 'INSTAGRAM',
      label: 'IG',
      accountExternalId: 'acct_1',
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

async function seedExternalObject(actor: Actor, workspaceId: string, connectionId: string, kind: string) {
  return db.runtime.withTenant(actor, (tx) =>
    tx.externalObject.create({
      data: {
        workspaceId,
        connectionId,
        platform: 'INSTAGRAM',
        kind,
        externalId: `ext_${Math.random().toString(36).slice(2)}`,
        raw: {},
        contentHash: 'hash',
        apiVersion: '1',
        fetchedAt: new Date(),
      },
    }),
  );
}

describe('enqueueAutomationEventsForObjects', () => {
  it('enqueues an AutomationEvent for a new inbound comment, keyed by the timeline event', async () => {
    const { actor, workspaceId, connectionId } = await seed();
    const ext = await seedExternalObject(actor, workspaceId, connectionId, 'comment');
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
          payload: {
            direction: 'inbound',
            body: 'what is the price?',
            conversationExternalId: 'conv_1',
          },
        },
      }),
    );

    const captured: ActiveJob[] = [];
    const { deps, bus } = makeDeps(captured);
    const { enqueued } = await enqueueAutomationEventsForObjects(deps, {
      workspaceId,
      connectionId,
      objectIds: [ext.id],
    });
    expect(enqueued).toBe(1);
    await bus.drain();
    expect(captured).toHaveLength(1);
    const event = captured[0]!.data as { type: string; payload: { body: string } };
    expect(event.type).toBe('comment.received');
    expect(event.payload.body).toBe('what is the price?');
  });

  it('does not enqueue for an outbound echo or for an object with no timeline event', async () => {
    const { actor, workspaceId, connectionId } = await seed();
    const ext = await seedExternalObject(actor, workspaceId, connectionId, 'message');
    await db.runtime.withTenant(actor, (tx) =>
      tx.timelineEvent.create({
        data: {
          workspaceId,
          type: 'MESSAGE',
          connectionId,
          occurredAt: new Date(),
          summary: 'you replied',
          externalObjectId: ext.id,
          dedupeKey: `t:${ext.externalId}`,
          payload: { direction: 'outbound', body: 'sure, $10' },
        },
      }),
    );
    const captured: ActiveJob[] = [];
    const { deps, bus } = makeDeps(captured);
    const outbound = await enqueueAutomationEventsForObjects(deps, {
      workspaceId,
      connectionId,
      objectIds: [ext.id],
    });
    expect(outbound.enqueued).toBe(0);

    const noEvent = await enqueueAutomationEventsForObjects(deps, {
      workspaceId,
      connectionId,
      objectIds: ['does-not-exist'],
    });
    expect(noEvent.enqueued).toBe(0);
    await bus.drain();
    expect(captured).toHaveLength(0);
  });
});
