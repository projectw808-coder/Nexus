import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import {
  createTestAuthCtx,
  createTestConnCtx,
  createTestNormalizeCtx,
} from '@nexus/connector-sdk/testing';
import { generatePkcePair, type TokenSet } from '@nexus/connector-sdk';
import {
  createMockConnector,
  MOCK_KINDS,
  mockManifest,
  type MockConnectorConfig,
} from './connector.ts';
import { createMockPlatform } from './platform.ts';
import mockComment from './fixtures/mock_comment.json' with { type: 'json' };
import mockPost from './fixtures/mock_post.json' with { type: 'json' };

const config: MockConnectorConfig = { baseUrl: 'https://mock.platform.local' };

type CtxExtra = Partial<
  Omit<
    Parameters<typeof createTestConnCtx<MockConnectorConfig>>[0],
    'manifest' | 'fetch' | 'config'
  >
>;

function ctxFor(
  platform: ReturnType<typeof createMockPlatform>,
  token?: TokenSet,
  extra: CtxExtra = {},
) {
  const issued = platform.issueToken();
  return createTestConnCtx<MockConnectorConfig>({
    manifest: mockManifest,
    fetch: platform.fetch,
    config,
    accountExternalId: 'acct_1',
    token: token ?? {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      scopes: ['read:posts', 'read:comments', 'write:reply_comment'],
      tokenType: 'Bearer',
      raw: {},
    },
    ...extra,
  });
}

// ── The SDK contract suite ──
const platform = createMockPlatform({ totalObjects: 1200, seed: 7 });
const connector = createMockConnector(config);
const webhookSample = await platform.emit(
  'comment.created',
  platform.comments[0]!,
  '/api/webhooks/mock/conn_test',
);

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(platform),
    resource: 'mock.comments',
    scenarios: {
      rateLimited: () => ctxFor(createMockPlatform({ totalObjects: 60, rateLimit: 0 })),
      expiredToken: () =>
        ctxFor(platform, { accessToken: 'expired', scopes: [], tokenType: 'Bearer', raw: {} }),
    },
    webhook: { valid: webhookSample.request, secret: platform.webhookSecret },
    fixtures: [
      { kind: MOCK_KINDS.post, raw: mockPost },
      { kind: MOCK_KINDS.comment, raw: mockComment },
    ],
    normalizeCtx: createTestNormalizeCtx(mockManifest, { accountExternalId: 'acct_1' }),
  },
);

// ── Mock-specific behaviour ──
describe('mock connector', () => {
  it('completes the OAuth dance with PKCE, refreshes and revokes', async () => {
    const p = createMockPlatform({ totalObjects: 12 });
    const auth = createTestAuthCtx({
      config,
      fetch: p.fetch,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
    });
    const pkce = generatePkcePair();
    const authUrl = new URL(
      connector.buildAuthUrl(auth, { scopes: ['read:posts'], state: 'st', pkce }),
    );
    expect(authUrl.searchParams.get('code_challenge')).toBe(pkce.challenge);
    const token = await connector.exchangeCode(auth, 'code-acct_1', pkce.verifier);
    expect(token.accessToken).toMatch(/^mock_at_/);
    expect(token.scopes).toContain('read:comments');
    const refreshed = await connector.refresh(auth, token);
    expect(refreshed.accessToken).not.toBe(token.accessToken);
    await connector.revoke(auth, refreshed);
    await expect(connector.refresh(auth, refreshed)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    await expect(connector.exchangeCode(auth, 'bogus', pkce.verifier)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
  });

  it('discovers accounts, verifies scopes and reports capabilities', async () => {
    const ctx = ctxFor(platform);
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts.map((a) => a.externalId)).toEqual(['acct_1', 'acct_2']);
    expect(await connector.capabilities(ctx)).toEqual([
      'read:posts',
      'read:comments',
      'write:reply_comment',
    ]);
    const limited = ctxFor(platform, {
      accessToken: platform.issueToken(['read:posts']).accessToken,
      scopes: ['read:posts'],
      tokenType: 'Bearer',
      raw: {},
    });
    const v = await connector.verifyScopes(limited);
    expect(v.missing).toEqual(['read:comments', 'write:reply_comment']);
    expect(v.degraded).toEqual(['read:comments', 'write:reply_comment']);
    expect(await connector.capabilities(limited)).toEqual(['read:posts']);
  });

  it('pages posts with a high-water mark and honours since', async () => {
    const ctx = ctxFor(platform);
    const first = await connector.fetchPage(ctx, {
      id: 'mock.posts',
      since: null,
      highWaterMark: null,
      pageSize: 50,
    });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]!.kind).toBe(MOCK_KINDS.post);
    expect(first.highWaterMark).toBeInstanceOf(Date);
    expect(first.servedApiVersion).toBe('2026-09');
    const since = new Date(Date.now() - 30 * 86_400_000);
    const later = await connector.fetchPage(ctx, {
      id: 'mock.posts',
      since,
      highWaterMark: null,
      pageSize: 500,
    });
    expect(later.items.every((i) => (i.occurredAt as Date) >= since)).toBe(true);
    expect(later.items.length).toBeGreaterThan(0);
    expect(later.items.length).toBeLessThan(platform.posts.length);
  });

  it('normalizes a comment into a person and an inbound message, and an own reply into an outbound message', () => {
    const nctx = createTestNormalizeCtx(mockManifest, { accountExternalId: 'acct_1' });
    const out = connector.normalize(MOCK_KINDS.comment, mockComment, nctx);
    expect(out.map((e) => e.kind)).toEqual(['person', 'message']);
    expect(out).toMatchSnapshot();
    const own = connector.normalize(
      MOCK_KINDS.comment,
      { ...mockComment, authorId: 'acct_1', replyToId: 'comment_7' },
      nctx,
    );
    expect(own.map((e) => e.kind)).toEqual(['message']);
    expect(own[0]).toMatchObject({ direction: 'outbound', parentExternalId: 'comment_7' });
    expect(connector.normalize(MOCK_KINDS.post, mockPost, nctx)).toMatchSnapshot();
  });

  it('refuses drifted shapes so core can quarantine them', () => {
    const nctx = createTestNormalizeCtx(mockManifest);
    expect(() =>
      connector.normalize(
        MOCK_KINDS.comment,
        { ...mockComment, body: undefined, content: 'renamed' },
        nctx,
      ),
    ).toThrow();
    expect(() =>
      connector.normalize(MOCK_KINDS.post, { ...mockPost, createdAt: 'yesterday' }, nctx),
    ).toThrow();
    expect(() => connector.normalize('mock_unknown', {}, nctx)).toThrow(NexusError);
  });

  it('parses webhooks with the connection id from the path and account from the body', () => {
    const [env] = connector.parseWebhook(webhookSample.request);
    expect(env).toMatchObject({
      kind: MOCK_KINDS.comment,
      externalId: platform.comments[0]!.id,
      connectionHint: { platform: 'MOCK', connectionId: 'conn_test', accountExternalId: 'acct_1' },
    });
    expect(connector.parseWebhook({ ...webhookSample.request, rawBody: '{"nope":1}' })).toEqual([]);
  });

  it('preflights and executes an idempotent reply, honouring dry-run', async () => {
    const ctx = ctxFor(platform);
    const target = platform.comments[3]!;
    const action = {
      id: 'oa_1',
      kind: 'reply_comment' as const,
      targetExternalId: target.id,
      payload: { text: 'Thanks!' },
      idempotencyKey: 'k-1',
      requestNonce: 'n-1',
      requestedByUserId: 'u1',
    };
    expect(await connector.preflight(ctx, action)).toEqual({ ok: true, warnings: [] });
    expect(await connector.preflight(ctx, { ...action, payload: { text: '  ' } })).toMatchObject({
      ok: false,
      code: 'VALIDATION',
    });
    expect(await connector.preflight(ctx, { ...action, kind: 'publish_post' })).toMatchObject({
      ok: false,
      code: 'POLICY_BLOCKED',
    });
    const first = await connector.execute(ctx, action);
    const again = await connector.execute(ctx, action);
    expect(again.externalId).toBe(first.externalId);
    expect(platform.stats.replies).toBe(1);
    const dry = ctxFor(platform, undefined, { settings: { dryRun: true } });
    const synthetic = await connector.execute(dry, { ...action, idempotencyKey: 'k-2' });
    expect(synthetic.externalId).toMatch(/^dry_/);
    expect(platform.stats.replies).toBe(1);
  });

  it('reports health without throwing, even when the platform is down', async () => {
    const healthy = await connector.health(ctxFor(platform));
    expect(healthy.status).toBe('healthy');
    const down = createTestConnCtx({
      manifest: mockManifest,
      fetch: async () => new Response('', { status: 503 }),
      config,
      accountExternalId: 'acct_1',
      retry: { maxAttempts: 1 },
    });
    const report = await connector.health(down);
    expect(report.status).toBe('down');
    expect(report.checks.find((c) => c.id === 'reachability')?.ok).toBe(false);
  });

  it('settles observed rate-limit headers into the budget', async () => {
    const ctx = ctxFor(platform);
    await connector.fetchPage(ctx, {
      id: 'mock.comments',
      since: null,
      highWaterMark: null,
      pageSize: 10,
    });
    const snap = await ctx.budget.snapshot();
    const w = snap.windows.find((x) => x.endpoint === 'GET /v1/accounts/:id/comments')!;
    expect(w.source).toBe('observed-header');
    expect(w.limit).toBe(1000);
  });
});

describe('mock platform faults', () => {
  it('injects 429 and 5xx deterministically and reports them', async () => {
    const faulty = createMockPlatform({
      totalObjects: 300,
      seed: 3,
      faults: { rate429: 0.5, rate5xx: 0.2 },
    });
    const ctx = ctxFor(faulty, undefined, { retry: { maxAttempts: 1 } });
    let ok = 0;
    let limited = 0;
    let down = 0;
    for (let i = 0; i < 30; i++) {
      try {
        await connector.fetchPage(ctx, {
          id: 'mock.posts',
          since: null,
          highWaterMark: null,
          pageSize: 5,
        });
        ok += 1;
      } catch (e) {
        if (e instanceof NexusError && e.code === 'RATE_LIMITED') limited += 1;
        else if (e instanceof NexusError && e.code === 'PLATFORM_DOWN') down += 1;
        else throw e;
      }
    }
    expect(ok + limited + down).toBe(30);
    expect(limited).toBeGreaterThan(5);
    expect(down).toBeGreaterThan(0);
    expect(faulty.stats.r429 + faulty.stats.r5xx).toBeGreaterThan(0);
  });

  it('injects schema drift into pages', async () => {
    const drifting = createMockPlatform({
      totalObjects: 120,
      seed: 9,
      faults: { schemaDriftRate: 0.3 },
    });
    const ctx = ctxFor(drifting);
    const page = await connector.fetchPage(ctx, {
      id: 'mock.comments',
      since: null,
      highWaterMark: null,
      pageSize: 100,
    });
    const drifted = page.items.filter((i) => 'content' in (i.raw as object));
    expect(drifted.length).toBeGreaterThan(5);
    expect(drifting.stats.driftInjected).toBe(drifted.length);
  });

  it('drops webhooks at the configured rate and records what it emitted', async () => {
    const lossy = createMockPlatform({
      totalObjects: 60,
      seed: 11,
      faults: { dropWebhookRate: 0.5 },
    });
    const delivered: string[] = [];
    lossy.onWebhook((req) => {
      delivered.push(req.headers['x-mock-delivery']!);
    });
    for (let i = 0; i < 40; i++) await lossy.newComment('acct_1');
    expect(lossy.emitted).toHaveLength(40);
    expect(delivered.length).toBeLessThan(40);
    expect(delivered.length).toBe(lossy.emitted.filter((e) => e.delivered).length);
    expect(lossy.stats.webhooksDropped).toBe(40 - delivered.length);
  });

  it('serves the same API over HTTP', async () => {
    const p = createMockPlatform({ totalObjects: 24 });
    const { url } = await p.listen();
    try {
      const res = await fetch(`${url}/v1/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-mock-api-version')).toBe('2026-09');
      const c = createMockConnector({ baseUrl: url });
      const t = p.issueToken();
      const ctx = createTestConnCtx({
        manifest: mockManifest,
        fetch: (u, i) => globalThis.fetch(u, i),
        config: { baseUrl: url },
        accountExternalId: 'acct_1',
        token: { accessToken: t.accessToken, scopes: ['read:posts'], tokenType: 'Bearer', raw: {} },
      });
      const page = await c.fetchPage(ctx, { id: 'mock.posts', since: null, highWaterMark: null });
      expect(page.items.length).toBeGreaterThan(0);
    } finally {
      await p.close();
    }
  });
});
