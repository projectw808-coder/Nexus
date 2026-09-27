import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import {
  createTestConnCtx,
  createTestNormalizeCtx,
  memoryLimiter,
} from '@nexus/connector-sdk/testing';
import type { RateLimiter } from '@nexus/connector-sdk';
import { createYoutubeConnector, type YoutubeConfig } from './connector.ts';
import { youtubeManifest, KINDS } from './manifest.ts';
import { createYoutubeDouble } from './testing/youtube-double.ts';
import ytVideo from './fixtures/yt_video.json' with { type: 'json' };
import ytCommentThread from './fixtures/yt_comment_thread.json' with { type: 'json' };
import ytCommentThreadDrift from './fixtures/yt_comment_thread.drift.json' with { type: 'json' };

const config: YoutubeConfig = { baseUrl: 'https://www.googleapis.test' };
const connector = createYoutubeConnector(config);

function ctxFor(
  double: ReturnType<typeof createYoutubeDouble>,
  extra: Partial<Parameters<typeof createTestConnCtx<YoutubeConfig>>[0]> = {},
) {
  return createTestConnCtx<YoutubeConfig>({
    manifest: youtubeManifest,
    fetch: double.fetch,
    config,
    accountExternalId: double.channelId,
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

const shared = createYoutubeDouble({ totalVideos: 7, totalComments: 7, pageSize: 3 });

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(shared),
    resource: 'yt.videos',
    scenarios: {
      rateLimited: () => ctxFor(createYoutubeDouble({ forceStatus: 429 })),
      expiredToken: () => ctxFor(createYoutubeDouble({ forceStatus: 401 })),
    },
    fixtures: [
      { kind: KINDS.video, raw: ytVideo },
      { kind: KINDS.commentThread, raw: ytCommentThread },
    ],
    normalizeCtx: createTestNormalizeCtx(youtubeManifest, {
      accountExternalId: shared.channelId,
    }),
  },
);

describe('YouTube connector', () => {
  it('buildAuthUrl points at accounts.google.com with the real client id, never googleapis.com', () => {
    const configured = createYoutubeConnector({
      baseUrl: 'https://www.googleapis.test',
      clientId: 'real-google-client',
    });
    const ctx = createTestConnCtx<YoutubeConfig>({
      manifest: youtubeManifest,
      fetch: () => Promise.reject(new Error('unused')),
      config: { baseUrl: 'https://www.googleapis.test', clientId: 'real-google-client' },
    });
    const authUrl = configured.buildAuthUrl(ctx, { scopes: ['https://www.googleapis.com/auth/youtube.readonly'], state: 'state123' });
    const parsed = new URL(authUrl);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('real-google-client');
  });

  it('listResources declares only yt.videos and yt.comments — no search.list resource', () => {
    const ids = connector.listResources().map((r) => r.id);
    expect(ids).toEqual(['yt.videos', 'yt.comments']);
    expect(ids).not.toContain('yt.search');
    expect(ids.some((id) => id.includes('search'))).toBe(false);
  });

  // ── #2: refuses search.list from a sync path ──
  it('refuses yt.search from the delta lane without ever calling the platform', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'delta' });
    let caught: unknown;
    try {
      await connector.fetchPage(ctx, { id: 'yt.search', since: null, highWaterMark: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).code).toBe('POLICY_BLOCKED');
    expect(double.searchCallCount()).toBe(0);
  });

  it('refuses yt.search from the backfill lane without ever calling the platform', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'backfill' });
    let caught: unknown;
    try {
      await connector.fetchPage(ctx, { id: 'yt.search', since: null, highWaterMark: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).code).toBe('POLICY_BLOCKED');
    expect(double.searchCallCount()).toBe(0);
  });

  it('refuses yt.search from the webhook lane without ever calling the platform', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'webhook' });
    let caught: unknown;
    try {
      await connector.fetchPage(ctx, { id: 'yt.search', since: null, highWaterMark: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).code).toBe('POLICY_BLOCKED');
    expect(double.searchCallCount()).toBe(0);
  });

  // ── #3: interactive search succeeds and consumes both buckets ──
  it('interactive-lane search succeeds and consumes both the unit pool and the search.list cap', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'interactive' });
    const before = await ctx.budget.snapshot();
    const dayBefore = before.windows.find((w) => w.id === 'day-units')!;
    const capBefore = before.windows.find((w) => w.id === 'search.list')!;
    expect(dayBefore.used).toBe(0);
    expect(capBefore).toMatchObject({ limit: 100, used: 0, remaining: 100 });

    const page = await connector.fetchPage(ctx, {
      id: 'yt.search',
      since: null,
      highWaterMark: null,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(double.searchCallCount()).toBe(1);

    const after = await ctx.budget.snapshot();
    const dayAfter = after.windows.find((w) => w.id === 'day-units')!;
    const capAfter = after.windows.find((w) => w.id === 'search.list')!;
    expect(dayAfter.used - dayBefore.used).toBe(1);
    expect(capAfter).toMatchObject({ limit: 100, used: 1, remaining: 99 });
  });

  // ── #4: independent-bucket exhaustion ──
  it('exhausts the search.list 100-calls/day cap independently of the 10,000-unit daily pool', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'interactive' });

    for (let i = 0; i < 100; i++) {
      await connector.fetchPage(ctx, { id: 'yt.search', since: null, highWaterMark: null });
    }
    expect(double.searchCallCount()).toBe(100);

    let caught: unknown;
    try {
      await connector.fetchPage(ctx, { id: 'yt.search', since: null, highWaterMark: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).code).toBe('QUOTA_EXHAUSTED');
    // The 101st call must never have reached the platform either.
    expect(double.searchCallCount()).toBe(100);

    const snapshot = await ctx.budget.snapshot();
    const dayWindow = snapshot.windows.find((w) => w.id === 'day-units')!;
    const capWindow = snapshot.windows.find((w) => w.id === 'search.list')!;
    // 100 search.list calls cost 100 units total out of 10,000 — proving the unit pool and the
    // capped-endpoint bucket are tracked independently, not conflated.
    expect(dayWindow.used).toBe(100);
    expect(dayWindow.remaining).toBe(9_900);
    expect(capWindow).toMatchObject({ limit: 100, used: 100, remaining: 0 });
  });

  // ── #5: snapshot reports both figures at all times, across mixed lanes ──
  it('budget.snapshot() always reports the daily unit pool and both capped-endpoint buckets', async () => {
    const { limiter }: { limiter: RateLimiter } = memoryLimiter();
    const double = createYoutubeDouble({ totalVideos: 5, totalComments: 5, pageSize: 5 });
    const connectionId = 'conn_mixed_lanes';
    const deltaCtx = ctxFor(double, { limiter, connectionId, lane: 'delta' });
    const interactiveCtx = ctxFor(double, { limiter, connectionId, lane: 'interactive' });

    await connector.fetchPage(deltaCtx, { id: 'yt.videos', since: null, highWaterMark: null });
    await connector.fetchPage(deltaCtx, { id: 'yt.comments', since: null, highWaterMark: null });
    await connector.fetchPage(interactiveCtx, {
      id: 'yt.search',
      since: null,
      highWaterMark: null,
    });
    await connector.fetchPage(interactiveCtx, {
      id: 'yt.search',
      since: null,
      highWaterMark: null,
    });

    const snapshot = await deltaCtx.budget.snapshot();
    const dayWindow = snapshot.windows.find((w) => w.id === 'day-units');
    const searchWindow = snapshot.windows.find((w) => w.id === 'search.list');
    const insertWindow = snapshot.windows.find((w) => w.id === 'videos.insert');

    expect(dayWindow).toBeDefined();
    expect(dayWindow!.used).toBe(4); // 1 (videos) + 1 (comments) + 2 (search)
    expect(searchWindow).toMatchObject({ limit: 100, used: 2, remaining: 98 });
    // videos.insert is declared but never called in this test — its bucket must still be reported.
    expect(insertWindow).toMatchObject({ limit: 100, used: 0, remaining: 100 });
  });

  // ── #6: write:reply_comment reserves 50 units ──
  it('reply_comment execute reserves 50 units, not 1', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double, { lane: 'interactive' });
    const before = await ctx.budget.snapshot();
    const dayBefore = before.windows.find((w) => w.id === 'day-units')!.used;

    const preflight = await connector.preflight(ctx, {
      id: 'oa_1',
      kind: 'reply_comment',
      targetExternalId: 'thread_0',
      payload: { text: 'Thanks for watching!' },
      idempotencyKey: 'idem_1',
      requestNonce: 'nonce_1',
      requestedByUserId: 'user_1',
    });
    expect(preflight.ok).toBe(true);

    const result = await connector.execute(ctx, {
      id: 'oa_1',
      kind: 'reply_comment',
      targetExternalId: 'thread_0',
      payload: { text: 'Thanks for watching!' },
      idempotencyKey: 'idem_1',
      requestNonce: 'nonce_1',
      requestedByUserId: 'user_1',
    });
    expect(result.externalId).toBeTruthy();
    expect(double.insertCallCount()).toBe(1);

    const after = await ctx.budget.snapshot();
    const dayAfter = after.windows.find((w) => w.id === 'day-units')!.used;
    expect(dayAfter - dayBefore).toBe(50);
  });

  it('preflight blocks an empty reply and a missing target', async () => {
    const ctx = ctxFor(shared);
    const emptyText = await connector.preflight(ctx, {
      id: 'oa_2',
      kind: 'reply_comment',
      targetExternalId: 'thread_0',
      payload: { text: '   ' },
      idempotencyKey: 'idem_2',
      requestNonce: 'nonce_2',
      requestedByUserId: 'user_1',
    });
    expect(emptyText).toMatchObject({ ok: false, code: 'VALIDATION' });

    const noTarget = await connector.preflight(ctx, {
      id: 'oa_3',
      kind: 'reply_comment',
      payload: { text: 'hello' },
      idempotencyKey: 'idem_3',
      requestNonce: 'nonce_3',
      requestedByUserId: 'user_1',
    });
    expect(noTarget).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  // ── #7: normalize purity + drift quarantine ──
  it('normalizes a video into a canonical video post', () => {
    const nctx = createTestNormalizeCtx(youtubeManifest, {
      accountExternalId: 'UCchannel0000000000000000',
    });
    const [entity] = connector.normalize(KINDS.video, ytVideo, nctx);
    expect(entity).toMatchObject({
      kind: 'post',
      mediaType: 'video',
      externalId: 'vid_abc123',
      authorExternalId: 'UCchannel0000000000000000',
      body: 'How We Shipped Phase 8',
    });
  });

  it('normalizes an inbound comment thread into a person + message', () => {
    const nctx = createTestNormalizeCtx(youtubeManifest, {
      accountExternalId: 'UCchannel0000000000000000',
    });
    const entities = connector.normalize(KINDS.commentThread, ytCommentThread, nctx);
    expect(entities).toHaveLength(2);
    const [person, message] = entities;
    expect(person).toMatchObject({ kind: 'person', displayName: 'Jane Doe' });
    expect(message).toMatchObject({
      kind: 'message',
      messageType: 'comment',
      direction: 'inbound',
      rootExternalId: 'vid_abc123',
      body: 'Great walkthrough, thanks!',
    });
  });

  it('normalizes an outbound comment thread (our own reply) into just a message', () => {
    const nctx = createTestNormalizeCtx(youtubeManifest, {
      accountExternalId: 'UCviewer0000000000000000',
    });
    const entities = connector.normalize(KINDS.commentThread, ytCommentThread, nctx);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ kind: 'message', direction: 'outbound' });
  });

  it('is pure: normalizing the same raw payload twice yields equal output and never mutates it', () => {
    const nctx = createTestNormalizeCtx(youtubeManifest);
    const raw = structuredClone(ytVideo);
    Object.freeze(raw);
    const a = connector.normalize(KINDS.video, raw, nctx);
    const b = connector.normalize(KINDS.video, raw, nctx);
    expect(b).toEqual(a);
    expect(raw).toEqual(ytVideo);
  });

  it('refuses a drifted comment-thread shape so core can quarantine it', () => {
    const nctx = createTestNormalizeCtx(youtubeManifest);
    expect(() => connector.normalize(KINDS.commentThread, ytCommentThreadDrift, nctx)).toThrow();
    expect(() => connector.normalize('yt_unknown', {}, nctx)).toThrow(NexusError);
  });

  // ── #8: health never touches search.list and spends minimal budget ──
  it('health() checks reachability without touching search.list or spending meaningful budget', async () => {
    const double = createYoutubeDouble();
    const ctx = ctxFor(double);
    const before = await ctx.budget.snapshot();
    const report = await connector.health(ctx);
    expect(report.status).toBe('healthy');
    expect(double.searchCallCount()).toBe(0);

    const after = await ctx.budget.snapshot();
    const dayBefore = before.windows.find((w) => w.id === 'day-units')!.used;
    const dayAfter = after.windows.find((w) => w.id === 'day-units')!.used;
    expect(dayAfter - dayBefore).toBeLessThanOrEqual(1);
    const searchWindow = after.windows.find((w) => w.id === 'search.list')!;
    expect(searchWindow.used).toBe(0);
  });

  it('reports health as reconnect_required when the token is rejected', async () => {
    const down = ctxFor(createYoutubeDouble({ forceStatus: 401 }));
    const report = await connector.health(down);
    expect(['reconnect_required', 'down']).toContain(report.status);
  });

  it('discovers the authenticated channel', async () => {
    const ctx = ctxFor(shared);
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platform: 'YOUTUBE', externalId: shared.channelId });
  });

  it('parseWebhook and verifyWebhook are always false/[] — YouTube has no push webhooks', () => {
    expect(
      connector.verifyWebhook(
        { method: 'POST', path: '/x', headers: {}, rawBody: '{}', query: {} },
        'secret',
      ),
    ).toBe(false);
    expect(
      connector.parseWebhook({ method: 'POST', path: '/x', headers: {}, rawBody: '{}', query: {} }),
    ).toEqual([]);
  });
});
