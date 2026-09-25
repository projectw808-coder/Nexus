/**
 * Phase 6 through the engine (spec §16): with the full sink chain (conversations → timeline →
 * identity) a Meta backfill produces a provenance-stamped timeline on identities, a lead form
 * resolves to the person who owns its e-mail, replays add nothing, an unresolved commenter keeps
 * a visible history of their own, and the nightly re-score files an explainable suggestion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraphDouble, type GraphDouble } from '@nexus/connector-meta/testing';
import {
  RateLimiter,
  MemoryBudgetStore,
  generateMasterKeyBase64,
  localKeyProvider,
  type Logger,
} from '@nexus/connector-sdk';
import {
  createRecord,
  createVault,
  loadAttributes,
  personAttributes,
  queryTimeline,
  systemActorFor,
  type Actor,
  type Prisma,
} from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus, type InlineBus } from './bus.ts';
import { completeOauth, connectPlatform, startOauth } from './connect.ts';
import type { SyncDeps } from './deps.ts';
import { runIdentityRescore } from './identity-rescore.ts';
import { deadLetterJob, handleJob } from './jobs.ts';
import { createConnectorRegistry } from './registry.ts';
import { replayConnection } from './replay.ts';
import { countingSink } from './sink.ts';
import { composeSinks, createConversationSink } from './sinks/conversations.ts';
import { createIdentitySink } from './sinks/identity.ts';
import { createTimelineSink } from './sinks/timeline.ts';
import { receiveWebhook } from './webhooks.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const vault = createVault({
  keyProvider: localKeyProvider({
    masterKeyId: 'local:test',
    masterKeyBase64: generateMasterKeyBase64(),
  }),
});

let db: TestDatabase;
let owner: Actor;
let userId: string;

type Sinks = {
  timeline: ReturnType<typeof createTimelineSink>;
  identity: ReturnType<typeof createIdentitySink>;
};

function makeDeps(graph: GraphDouble): SyncDeps & { bus: InlineBus; sinks: Sinks } {
  const sinks: Sinks = {
    timeline: createTimelineSink(db.runtime),
    identity: createIdentitySink(db.runtime),
  };
  const deps: SyncDeps & { bus: InlineBus; sinks: Sinks } = {
    runtime: db.runtime,
    vault,
    limiter: new RateLimiter({ store: new MemoryBudgetStore(), random: () => 0.5 }),
    registry: createConnectorRegistry({ meta: { graphOrigin: graph.origin, appId: graph.appId } }),
    sink: composeSinks(
      countingSink(),
      createConversationSink(db.runtime),
      sinks.timeline,
      sinks.identity,
    ),
    sinks,
    logger: quiet,
    appSecrets: {
      webhookSecret: () => graph.appSecret,
      oauthCredentials: async () => ({ clientId: graph.appId, clientSecret: graph.appSecret }),
      stateSecret: () => 'state',
    },
    fetchFor: () => graph.fetch,
    appUrl: 'http://localhost:3000',
    httpRetry: { baseMs: 1, capMs: 3, maxAttempts: 2 },
    bus: undefined as unknown as InlineBus,
  };
  deps.bus = createInlineBus({
    handlers: {
      'sync.backfill': (j) => handleJob(deps, j),
      'sync.delta': (j) => handleJob(deps, j),
      normalize: (j) => handleJob(deps, j),
      'ingest.raw': (j) => handleJob(deps, j),
      outbound: (j) => handleJob(deps, j),
    },
    onDeadLetter: (job, error) => deadLetterJob(deps, job, error),
    retry: { baseMs: 1, capMs: 5 },
    logger: quiet,
  });
  return deps;
}

async function connectMeta(deps: SyncDeps) {
  const start = startOauth(deps, {
    workspaceId: owner.workspaceId,
    userId,
    platform: 'FACEBOOK',
    returnTo: '/w/acme/inbox',
  });
  const done = await completeOauth(deps, { code: 'AQtestcode', state: start.state });
  return connectPlatform(deps, {
    actor: owner,
    platform: 'FACEBOOK',
    token: done.token,
    backfill: true,
  });
}

async function person(values: Record<string, unknown>) {
  return db.runtime.withTenant(owner, async (t) => {
    const pa = await personAttributes(t);
    const attrs = await loadAttributes(t, pa.objectTypeId);
    const bySlug = Object.fromEntries(attrs.map((a) => [a.apiSlug, a.id]));
    return createRecord(t, owner, {
      objectTypeId: pa.objectTypeId,
      attributes: attrs,
      input: Object.fromEntries(Object.entries(values).map(([k, v]) => [bySlug[k]!, v])),
    });
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@identity.test', name: 'Owner' } });
  userId = u.id;
  const ws = await db.tenancy.createWorkspace({
    name: 'Identity',
    slug: 'identity',
    ownerUserId: userId,
  });
  owner = { ...systemActorFor(ws.id), userId, actorType: 'USER' };
});
afterAll(async () => db.close());

describe('identity resolution through the engine', () => {
  it('backfill → timeline on identities, lead resolved by e-mail, replay adds nothing', async () => {
    const dana = await person({ name: 'Dana Wholesale', email: 'dana@wholesale.test' });
    const graph = createGraphDouble({
      conversations: 2,
      messagesPerConversation: 2,
      posts: 1,
      commentsPerPost: 2,
    });
    const deps = makeDeps(graph);
    const { connections } = await connectMeta(deps);
    await deps.bus.drain();
    const fb = connections[0]!;

    const byType = await db.runtime.withTenant(owner, (t) =>
      t.timelineEvent.groupBy({ by: ['type'], _count: { _all: true } }),
    );
    const counts = Object.fromEntries(byType.map((g) => [g.type, g._count._all]));
    expect(counts['MESSAGE']).toBeGreaterThanOrEqual(2); // inbound DMs on Messenger + Instagram
    expect(counts['COMMENT']).toBeGreaterThanOrEqual(2); // comments + reviews
    expect(counts['MENTION']).toBeGreaterThanOrEqual(1);
    expect(counts['LEAD_FORM']).toBe(1);
    // Every sink-produced event names its platform, connection, raw object and actor.
    const events = await db.runtime.withTenant(owner, (t) =>
      t.timelineEvent.findMany({
        where: { type: { in: ['MESSAGE', 'COMMENT', 'MENTION', 'LEAD_FORM'] } },
      }),
    );
    expect(
      events.every(
        (e) => e.platform && e.connectionId && e.externalObjectId && e.identityId && e.dedupeKey,
      ),
    ).toBe(true);
    expect(deps.sinks.timeline.stats.events).toBe(events.length);

    // The lead form carried Dana's e-mail: its synthetic identity linked to her at once, and
    // the LEAD_FORM event is on her record — with the platform, form and fields as provenance.
    const lead = await db.runtime.withTenant(owner, (t) =>
      t.identity.findFirstOrThrow({
        where: { externalId: { startsWith: 'lead:' } },
        include: { links: true },
      }),
    );
    expect(lead.personRecordId).toBe(dana.id);
    expect(lead.links[0]).toMatchObject({ method: 'EXACT_EMAIL', confidence: 1 });
    const tl = await db.runtime.withTenant(owner, (t) =>
      queryTimeline(t, { workspaceId: owner.workspaceId, recordId: dana.id }),
    );
    const leadEvent = tl.items.find((e) => e.type === 'LEAD_FORM');
    expect(leadEvent).toBeDefined();
    expect(leadEvent!.summary).toContain('Wholesale enquiry');
    expect(leadEvent!.connection?.id).toBe(fb.id);
    expect(leadEvent!.provenance).toBe('identity');
    expect((leadEvent!.payload as { fields: unknown[] }).fields).toHaveLength(4);
    expect(
      tl.items.some((e) => e.type === 'SYSTEM' && e.summary.startsWith('Linked Facebook')),
    ).toBe(true);
    const audits = await db.runtime.withTenant(owner, (t) =>
      t.auditLog.findMany({ where: { action: 'identity.auto_linked', actorType: 'SYSTEM' } }),
    );
    expect(audits).toHaveLength(1);

    // Everyone else has no anchor: they stay unresolved and their history is on the identity.
    const unresolved = await db.runtime.withTenant(owner, (t) =>
      t.identity.findMany({ where: { personRecordId: null } }),
    );
    expect(unresolved.length).toBeGreaterThan(3);
    expect(unresolved.every((i) => i.resolutionAttemptedAt !== null)).toBe(true);
    const customer = unresolved.find((i) => i.displayName === 'Customer 1')!;
    const own = await db.runtime.withTenant(owner, (t) =>
      queryTimeline(t, { workspaceId: owner.workspaceId, identityId: customer.id }),
    );
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every((e) => e.recordId === null)).toBe(true);

    // Replaying every raw object from the normalize stage adds no events and no identities.
    const before = {
      events: await db.runtime.withTenant(owner, (t) => t.timelineEvent.count()),
      identities: await db.runtime.withTenant(owner, (t) => t.identity.count()),
    };
    for (const c of connections) {
      await replayConnection(deps, {
        workspaceId: owner.workspaceId,
        connectionId: c.id,
        fromStage: 'normalize',
      });
    }
    await deps.bus.drain();
    expect(await db.runtime.withTenant(owner, (t) => t.timelineEvent.count())).toBe(before.events);
    expect(await db.runtime.withTenant(owner, (t) => t.identity.count())).toBe(before.identities);

    // A webhook DM from a known customer lands on the same identity, and the same webhook
    // delivered twice yields one event.
    const psid = customer.externalId;
    const hook = graph.messageWebhook({ psid, text: 'Still there?' });
    await receiveWebhook(deps, 'FACEBOOK', { ...hook, path: `/api/webhooks/facebook/${fb.id}` });
    await deps.bus.drain();
    await receiveWebhook(deps, 'FACEBOOK', { ...hook, path: `/api/webhooks/facebook/${fb.id}` });
    await deps.bus.drain();
    const after = await db.runtime.withTenant(owner, (t) =>
      queryTimeline(t, {
        workspaceId: owner.workspaceId,
        identityId: customer.id,
        types: ['MESSAGE'],
      }),
    );
    expect(after.items.filter((e) => e.summary.includes('Still there?'))).toHaveLength(1);
    expect(after.items[0]!.summary).toBe('Sent a message: “Still there?”');
  });

  it('the nightly re-score files an explainable suggestion and promotes it on new evidence', async () => {
    const ws = await db.tenancy.createWorkspace({
      name: 'Nightly',
      slug: 'nightly',
      ownerUserId: userId,
    });
    owner = { ...systemActorFor(ws.id), userId, actorType: 'USER' };
    const graph = createGraphDouble({
      conversations: 1,
      messagesPerConversation: 1,
      posts: 1,
      commentsPerPost: 1,
    });
    const deps = makeDeps(graph);
    await connectMeta(deps);
    await deps.bus.drain();
    // Nobody matched during the backfill. A teammate now creates "Customer 1" by hand…
    const p = await person({ name: 'Customer 1' });
    const first = await runIdentityRescore(deps, {
      workspaceId: ws.id,
      now: new Date(Date.now() + 2 * 86_400_000),
    });
    expect(first.identities.scored).toBeGreaterThan(0);
    expect(first.identities.suggested).toBeGreaterThanOrEqual(1);
    const s = await db.runtime.withTenant(owner, (t) =>
      t.mergeSuggestion.findFirstOrThrow({
        where: { rightRecordId: p.id, status: 'PENDING' },
        include: { identity: true },
      }),
    );
    expect(s.identity?.displayName).toBe('Customer 1');
    const why = s.signals as {
      score: number;
      signals: { kind: string; label: string; tier: number }[];
    };
    expect(why.score).toBe(0.4);
    expect(why.signals[0]).toMatchObject({ kind: 'NAME_FUZZY', tier: 3 });
    expect(why.signals[0]!.label).toContain('customer 1');
    // …then adds the e-mail Messenger reported for that customer. Next night: promoted.
    await db.runtime.withTenant(owner, (t) =>
      t.identity.update({ where: { id: s.identityId! }, data: { email: 'customer1@example.com' } }),
    );
    await db.runtime.withTenant(owner, async (t) => {
      const pa = await personAttributes(t);
      await t.record.update({
        where: { id: p.id },
        data: {
          values: {
            ...p.values,
            [pa.ids.email!]: 'customer1@example.com',
          } as Prisma.InputJsonValue,
        },
      });
    });
    const second = await runIdentityRescore(deps, {
      workspaceId: ws.id,
      now: new Date(Date.now() + 3 * 86_400_000),
    });
    expect(second.suggestions.promoted).toBe(1);
    const linked = await db.runtime.withTenant(owner, (t) =>
      t.identity.findUniqueOrThrow({ where: { id: s.identityId! } }),
    );
    expect(linked.personRecordId).toBe(p.id);
    const promoted = await db.runtime.withTenant(owner, (t) =>
      t.mergeSuggestion.findUniqueOrThrow({ where: { id: s.id } }),
    );
    expect(promoted.status).toBe('AUTO_MERGED');
    const audit = await db.runtime.withTenant(owner, (t) =>
      t.auditLog.findMany({ where: { action: 'merge_suggestion.auto_merged' } }),
    );
    expect(audit).toHaveLength(1);
  });
});
