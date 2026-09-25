/**
 * Phase 4 acceptance (spec §16): against the mock platform, on PGlite, with the inline bus —
 *   · a mock connector backfills 50k objects
 *   · resumes after a worker kill
 *   · survives 30% injected 429/5xx without data loss
 *   · replaying every webhook 3× produces zero duplicates
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockPlatform, type MockPlatform } from '@nexus/connector-mock';
import {
  RateLimiter,
  MemoryBudgetStore,
  generateMasterKeyBase64,
  localKeyProvider,
  type Logger,
} from '@nexus/connector-sdk';
import { createVault, systemActorFor, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus, type InlineBus } from './bus.ts';
import { completeOauth, connectPlatform, startOauth } from './connect.ts';
import type { SyncDeps } from './deps.ts';
import { deadLetterJob, handleJob } from './jobs.ts';
import { createConnectorRegistry } from './registry.ts';
import { replayConnection, replayDeadLetter } from './replay.ts';
import { enqueueBackfill } from './scheduler.ts';
import { countingSink } from './sink.ts';
import { sweepTokens } from './token-refresh.ts';
import { receiveWebhook } from './webhooks.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const vault = createVault({
  keyProvider: localKeyProvider({
    masterKeyId: 'local:test',
    masterKeyBase64: generateMasterKeyBase64(),
  }),
});

let db: TestDatabase;
let userId: string;
let owner: Actor;
let wsSeq = 0;

function makeDeps(
  platform: MockPlatform,
  opts: {
    retryBaseMs?: number;
    concurrency?: number;
    maxAttempts?: number;
    onRequest?: (n: number) => void;
  } = {},
): SyncDeps & { bus: InlineBus; sink: ReturnType<typeof countingSink> } {
  const registry = createConnectorRegistry({ mockBaseUrl: platform.baseUrl });
  const limiter = new RateLimiter({
    store: new MemoryBudgetStore(),
    random: () => 0.5,
    breaker: { baseOpenMs: 5, maxOpenMs: 20 },
  });
  const sink = countingSink();
  const deps: SyncDeps & { bus: InlineBus; sink: typeof sink } = {
    runtime: db.runtime,
    vault,
    limiter,
    registry,
    sink,
    logger: quiet,
    appSecrets: {
      webhookSecret: () => platform.webhookSecret,
      oauthCredentials: async () => ({
        clientId: platform.clientId,
        clientSecret: platform.clientSecret,
      }),
      stateSecret: () => 'state-secret-for-tests',
    },
    fetchFor: () => {
      let n = 0;
      return (url, init) => {
        opts.onRequest?.(++n);
        return platform.fetch(url, init);
      };
    },
    appUrl: 'http://localhost:3000',
    httpRetry: { baseMs: 1, capMs: 3, maxAttempts: 3 },
    bus: undefined as unknown as InlineBus,
  };
  deps.bus = createInlineBus({
    handlers: {
      'sync.backfill': (j) => handleJob(deps, j),
      'sync.delta': (j) => handleJob(deps, j),
      normalize: (j) => handleJob(deps, j),
      'ingest.raw': (j) => handleJob(deps, j),
    },
    onDeadLetter: (job, error) => deadLetterJob(deps, job, error),
    retry: { baseMs: opts.retryBaseMs ?? 1, capMs: 5, maxAttempts: opts.maxAttempts ?? 6 },
    concurrency: opts.concurrency ?? 4,
    logger: quiet,
  });
  return deps;
}

async function connectMock(deps: SyncDeps, platform: MockPlatform, backfill = false) {
  const start = startOauth(deps, {
    workspaceId: owner.workspaceId,
    userId: owner.userId!,
    platform: 'MOCK',
    returnTo: '/w/acme/settings/integrations',
  });
  const done = await completeOauth(deps, {
    code: 'code-acct_1',
    state: start.state,
    verifier: start.verifier,
  });
  return connectPlatform(deps, {
    actor: owner,
    platform: 'MOCK',
    token: done.token,
    accountExternalIds: ['acct_1'],
    backfill,
  });
}

async function counts(connectionId: string) {
  return db.runtime.withTenant(owner, async (tx) => ({
    objects: await tx.externalObject.count({ where: { connectionId } }),
    normalized: await tx.externalObject.count({
      where: { connectionId, normalizedAt: { not: null } },
    }),
    quarantined: await tx.externalObject.count({
      where: { connectionId, quarantinedAt: { not: null } },
    }),
    runs: await tx.syncRun.findMany({ where: { connectionId }, orderBy: { startedAt: 'asc' } }),
    errors: await tx.integrationError.count({ where: { connectionId } }),
    deadLetters: await tx.deadLetter.count({ where: { connectionId } }),
    webhookEvents: await tx.webhookEvent.findMany({ where: { connectionId } }),
  }));
}

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@engine.test', name: 'Owner' } });
  userId = u.id;
});
// Every test gets its own workspace so connections (keyed by workspace + platform + account) never collide.
beforeEach(async () => {
  wsSeq += 1;
  const ws = await db.tenancy.createWorkspace({
    name: `Acme ${wsSeq}`,
    slug: `acme-${wsSeq}`,
    ownerUserId: userId,
  });
  owner = { ...systemActorFor(ws.id), userId, actorType: 'USER' };
});
afterAll(async () => db.close());

describe('connecting a platform', () => {
  it('runs OAuth with PKCE, vaults the token and secret, audits, and reports capabilities', async () => {
    const platform = createMockPlatform({ totalObjects: 60, accounts: 2 });
    const deps = makeDeps(platform);
    const start = startOauth(deps, {
      workspaceId: owner.workspaceId,
      userId: owner.userId!,
      platform: 'MOCK',
      returnTo: '/back',
    });
    expect(new URL(start.authorizeUrl).searchParams.get('code_challenge')).toBeTruthy();
    const done = await completeOauth(deps, {
      code: 'code-acct_1',
      state: start.state,
      verifier: start.verifier,
    });
    expect(done.returnTo).toBe('/back');
    await expect(
      completeOauth(deps, {
        code: 'code-acct_1',
        state: `${start.state}x`,
        verifier: start.verifier,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const result = await connectPlatform(deps, {
      actor: owner,
      platform: 'MOCK',
      token: done.token,
      backfill: false,
    });
    expect(result.connections).toHaveLength(2);
    expect(result.connections.every((c) => c.created)).toBe(true);
    const rows = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findMany({
        where: { platform: 'MOCK' },
        orderBy: { accountExternalId: 'asc' },
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['CONNECTED', 'CONNECTED']);
    expect(rows[0]!.capabilities).toEqual(['read:posts', 'read:comments', 'write:reply_comment']);
    expect(rows[0]!.tokenRef).not.toContain('mock_at_');
    const vaulted = await db.runtime.withTenant(owner, (tx) =>
      vault.getTokenSet(tx, rows[0]!.tokenRef),
    );
    expect(vaulted.token.accessToken).toBe(done.token.accessToken);
    const audits = await db.runtime.withTenant(owner, (tx) =>
      tx.auditLog.findMany({ where: { action: 'connection.created' } }),
    );
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain(done.token.accessToken);
    expect(platform.subscriptions.has('mock.comments')).toBe(true);
    // Reconnecting is idempotent.
    const again = await connectPlatform(deps, {
      actor: owner,
      platform: 'MOCK',
      token: done.token,
      backfill: false,
    });
    expect(again.connections.every((c) => !c.created)).toBe(true);
  });
});

describe('backfill', () => {
  it('backfills 50,000 objects, normalizes every one and resumes after a worker kill', async () => {
    const platform = createMockPlatform({ totalObjects: 50_000, accounts: 1, seed: 1 });
    // The kill fires from inside the request path once a dozen pages have been fetched: PGlite runs
    // synchronously in WASM, so a timer-based watcher would only wake up after the backfill finished.
    let killAt = Number.POSITIVE_INFINITY;
    const deps = makeDeps(platform, {
      concurrency: 6,
      onRequest: (n) => {
        if (n >= killAt) deps.bus.stop();
      },
    });
    const { connections } = await connectMock(deps, platform, false);
    const connectionId = connections[0]!.id;
    const expected = platform.posts.length + platform.comments.length;
    expect(expected).toBe(50_000);

    // First worker: killed after a dozen pages have been fetched.
    const startedAt = Date.now();
    killAt = platform.stats.requests + 12;
    await enqueueBackfill(deps, { workspaceId: owner.workspaceId, connectionId, platform: 'MOCK' });
    await deps.bus.drain();
    const afterKill = await counts(connectionId);
    expect(afterKill.objects).toBeGreaterThan(0);
    expect(afterKill.objects).toBeLessThan(expected);
    const cursors = await db.runtime.withTenant(owner, (tx) =>
      tx.syncCursor.findMany({ where: { connectionId } }),
    );
    expect(cursors.some((c) => c.cursor !== null)).toBe(true); // a page cursor survived the kill
    expect(afterKill.runs.every((r) => r.status === 'CANCELLED' || r.status === 'SUCCEEDED')).toBe(
      true,
    );

    // Second worker: fresh bus and limiter, same database.
    const deps2 = makeDeps(platform, { concurrency: 6 });
    const requestsBefore = platform.stats.requests;
    await enqueueBackfill(deps2, {
      workspaceId: owner.workspaceId,
      connectionId,
      platform: 'MOCK',
    });
    await deps2.bus.drain();
    const elapsedMs = Date.now() - startedAt;
    const final = await counts(connectionId);
    expect(final.objects).toBe(expected);
    expect(final.normalized).toBe(expected);
    expect(final.quarantined).toBe(0);
    expect(final.deadLetters).toBe(0);
    // Resumed from the saved cursors: far fewer pages than a restart from zero would need.
    expect(platform.stats.requests - requestsBefore).toBeLessThan(expected / 500 + 5);
    expect(final.runs.filter((r) => r.status === 'SUCCEEDED').length).toBeGreaterThanOrEqual(2);
    expect(final.runs.reduce((s, r) => s + r.itemsCreated, 0)).toBe(expected);
    const sinkEntities =
      (deps.sink.counts['message'] ?? 0) +
      (deps2.sink.counts['message'] ?? 0) +
      (deps.sink.counts['post'] ?? 0) +
      (deps2.sink.counts['post'] ?? 0);
    expect(sinkEntities).toBe(expected);
    const perMinute = Math.round((expected / elapsedMs) * 60_000);
    console.warn(
      `backfill: ${expected} objects in ${elapsedMs} ms (${perMinute}/min), ${platform.stats.requests} platform calls, killed at ${afterKill.objects} objects`,
    );
    // A delta poll afterwards finds nothing new and spends one page per resource.
    const before = platform.stats.requests;
    await deps2.bus.enqueue({
      queue: 'sync.delta',
      name: 'sync',
      data: {
        workspaceId: owner.workspaceId,
        connectionId,
        resource: 'mock.comments',
        trigger: 'SCHEDULE',
        lane: 'delta',
      },
    });
    await deps2.bus.drain();
    expect((await counts(connectionId)).objects).toBe(expected);
    expect(platform.stats.requests - before).toBeLessThanOrEqual(2);
  });

  it('survives 30% injected 429 / 5xx without losing data', async () => {
    const platform = createMockPlatform({
      totalObjects: 6_000,
      accounts: 1,
      seed: 5,
      pageSizeMax: 100,
      faults: { rate429: 0.15, rate5xx: 0.15, retryAfterSeconds: 0 },
    });
    const deps = makeDeps(platform, { concurrency: 3 });
    const { connections } = await connectMock(deps, platform, true);
    const connectionId = connections[0]!.id;
    await deps.bus.drain();
    const c = await counts(connectionId);
    expect(c.objects).toBe(6_000);
    expect(c.normalized).toBe(6_000);
    expect(c.deadLetters).toBe(0);
    expect(platform.stats.r429).toBeGreaterThan(5);
    expect(platform.stats.r5xx).toBeGreaterThan(5);
    expect(c.runs.some((r) => r.status === 'FAILED')).toBe(true); // failures were recorded…
    expect(c.runs.at(-1)?.status).toBe('SUCCEEDED'); // …and the last run finished the job
    expect(c.errors).toBeGreaterThan(0);
    const conn = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(conn.status).toBe('CONNECTED'); // recovered from DEGRADED
  });

  it('quarantines schema drift without dropping the raw payload, and replays from normalize', async () => {
    const platform = createMockPlatform({
      totalObjects: 400,
      accounts: 1,
      seed: 8,
      faults: { schemaDriftRate: 0.25 },
    });
    const deps = makeDeps(platform);
    const { connections } = await connectMock(deps, platform, true);
    const connectionId = connections[0]!.id;
    await deps.bus.drain();
    const c = await counts(connectionId);
    expect(c.objects).toBe(400);
    expect(c.quarantined).toBeGreaterThan(50);
    expect(c.normalized + c.quarantined).toBe(400);
    const drifted = await db.runtime.withTenant(owner, (tx) =>
      tx.integrationError.findMany({
        where: { connectionId, errorClass: 'SCHEMA_DRIFT' },
        take: 3,
      }),
    );
    expect(drifted.length).toBe(3);
    expect(drifted[0]!.externalObjectId).toBeTruthy();
    // Replay from normalize re-runs the pure mapper over the stored raw: still drifted → still quarantined, nothing lost.
    const r = await replayConnection(deps, {
      workspaceId: owner.workspaceId,
      connectionId,
      fromStage: 'normalize',
    });
    expect(r.objects).toBe(400);
    await deps.bus.drain();
    expect((await counts(connectionId)).quarantined).toBe(c.quarantined);
    // The platform fixes its payloads; a fresh backfill updates the changed rows and they normalize.
    platform.setFaults({ schemaDriftRate: 0 });
    await enqueueBackfill(deps, { workspaceId: owner.workspaceId, connectionId, platform: 'MOCK' });
    await deps.bus.drain();
    const fixed = await counts(connectionId);
    expect(fixed.objects).toBe(400);
    expect(fixed.quarantined).toBe(0);
    expect(fixed.normalized).toBe(400);
  });
});

describe('webhooks', () => {
  it('verifies, persists, routes and processes; replaying every webhook 3× yields zero duplicates', async () => {
    const platform = createMockPlatform({ totalObjects: 300, accounts: 1, seed: 21 });
    const deps = makeDeps(platform);
    const { connections } = await connectMock(deps, platform, true);
    const connectionId = connections[0]!.id;
    await deps.bus.drain();
    const baseline = (await counts(connectionId)).objects;
    const entitiesBefore = deps.sink.distinctEntities;

    const responses: number[] = [];
    platform.onWebhook(async (req) => {
      const r = await receiveWebhook(deps, 'MOCK', {
        ...req,
        path: `/api/webhooks/mock/${connectionId}`,
      });
      responses.push(r.status);
    });
    for (let i = 0; i < 200; i++) await platform.newComment('acct_1');
    // Platforms redeliver: every webhook arrives three times in total.
    for (let round = 0; round < 2; round++) {
      for (const e of platform.emitted)
        await receiveWebhook(deps, 'MOCK', {
          ...e.request,
          path: `/api/webhooks/mock/${connectionId}`,
        });
    }
    await deps.bus.drain();
    const c = await counts(connectionId);
    expect(responses.filter((s) => s !== 200)).toEqual([]);
    expect(responses).toHaveLength(200);
    expect(c.objects).toBe(baseline + 200);
    expect(c.normalized).toBe(baseline + 200);
    expect(c.webhookEvents).toHaveLength(600);
    expect(c.webhookEvents.every((w) => w.verified && w.processedAt !== null)).toBe(true);
    // Each new comment yields one message and (at most) one new person; never three of each.
    expect(deps.sink.distinctEntities - entitiesBefore).toBeLessThanOrEqual(400);
    expect(deps.sink.distinctEntities - entitiesBefore).toBeGreaterThanOrEqual(200);
    // A poll that returns the same comments afterwards changes nothing either.
    await deps.bus.enqueue({
      queue: 'sync.delta',
      name: 'sync',
      data: {
        workspaceId: owner.workspaceId,
        connectionId,
        resource: 'mock.comments',
        trigger: 'SCHEDULE',
        lane: 'delta',
      },
    });
    await deps.bus.drain();
    expect((await counts(connectionId)).objects).toBe(baseline + 200);
  });

  it('rejects tampered or unsigned payloads with 401 and logs them unverified', async () => {
    const platform = createMockPlatform({ totalObjects: 30, accounts: 1 });
    const deps = makeDeps(platform);
    const { connections } = await connectMock(deps, platform, false);
    const connectionId = connections[0]!.id;
    const { webhook } = await platform.newComment('acct_1');
    const path = `/api/webhooks/mock/${connectionId}`;
    const tampered = await receiveWebhook(deps, 'MOCK', {
      ...webhook.request,
      path,
      rawBody: Buffer.from(webhook.request.rawBody).toString('utf8').replace('"event"', '"evenT"'),
    });
    expect(tampered.status).toBe(401);
    const unsigned = await receiveWebhook(deps, 'MOCK', {
      ...webhook.request,
      path,
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.status).toBe(401);
    // GMAIL has no connector registered (Google Workspace connectors are deferred past Phase 8,
    // ADR-019) — any platform absent from the registry proves the "unknown platform" 404 path.
    const unknown = await receiveWebhook(deps, 'GMAIL', webhook.request);
    expect(unknown.status).toBe(404);
    await deps.bus.drain();
    const c = await counts(connectionId);
    expect(c.webhookEvents.filter((w) => !w.verified)).toHaveLength(2);
    expect(c.objects).toBe(0);
  });
});

describe('dead letters and token sweep', () => {
  it('dead-letters a job after the retry budget and replays it once the platform recovers', async () => {
    const platform = createMockPlatform({ totalObjects: 40, accounts: 1 });
    const deps = makeDeps(platform, { maxAttempts: 2 });
    const { connections } = await connectMock(deps, platform, false);
    const connectionId = connections[0]!.id;
    platform.setFaults({ rate5xx: 1 });
    await enqueueBackfill(deps, {
      workspaceId: owner.workspaceId,
      connectionId,
      platform: 'MOCK',
      resources: ['mock.posts'],
    });
    await deps.bus.drain();
    const c = await counts(connectionId);
    expect(c.deadLetters).toBe(1);
    expect(c.objects).toBe(0);
    const conn = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(conn.status).toBe('DEGRADED');
    platform.setFaults({ rate5xx: 0 });
    const dl = await db.runtime.withTenant(owner, (tx) =>
      tx.deadLetter.findFirstOrThrow({ where: { connectionId } }),
    );
    expect(dl.errorClass).toBe('PLATFORM_DOWN');
    await replayDeadLetter(deps, { workspaceId: owner.workspaceId, id: dl.id });
    await expect(
      replayDeadLetter(deps, { workspaceId: owner.workspaceId, id: dl.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await deps.bus.drain();
    const after = await counts(connectionId);
    expect(after.objects).toBe(platform.posts.length);
    expect(after.deadLetters).toBe(1); // the row stays, marked replayed
  });

  it('refreshes tokens at 70% of lifetime and flags unrefreshable ones seven days out', async () => {
    const platform = createMockPlatform({
      totalObjects: 10,
      accounts: 1,
      tokenTtlSeconds: 10 * 86_400,
    });
    const deps = makeDeps(platform);
    const { connections } = await connectMock(deps, platform, false);
    const connectionId = connections[0]!.id;
    const before = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    // 8 days later: past 70% of a 10-day token → refresh.
    const later = { ...deps, now: () => new Date(Date.now() + 8 * 86_400_000) };
    const r1 = await sweepTokens(later);
    expect(r1.refreshed).toBeGreaterThanOrEqual(1);
    const after = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(before.tokenExpiresAt!.getTime());
    expect(after.status).toBe('CONNECTED');
    // Strip the refresh path and move within 7 days of expiry → reconnect required, notified.
    const { token } = await db.runtime.withTenant(owner, (tx) =>
      vault.getTokenSet(tx, after.tokenRef),
    );
    await db.runtime.withTenant(owner, (tx) =>
      vault.rotateTokenSet(tx, after.tokenRef, {
        ...token,
        refreshToken: undefined,
        expiresAt: new Date(Date.now() + 3 * 86_400_000),
      }),
    );
    await db.runtime.withTenant(owner, (tx) =>
      tx.connection.update({
        where: { id: connectionId },
        data: { tokenExpiresAt: new Date(Date.now() + 3 * 86_400_000) },
      }),
    );
    const notified: string[] = [];
    const r2 = await sweepTokens(deps, {
      notifier: { reconnectRequired: async (i) => void notified.push(i.connectionId) },
    });
    expect(r2.reconnectRequired).toBeGreaterThanOrEqual(1);
    expect(notified).toContain(connectionId);
    const flagged = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(flagged.status).toBe('RECONNECT_REQUIRED');
    expect(flagged.pausedReason).toMatch(/7 days/);
  });
});
