import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import {
  createTestAuthCtx,
  createTestConnCtx,
  createTestNormalizeCtx,
} from '@nexus/connector-sdk/testing';
import type { TokenSet } from '@nexus/connector-sdk';
import { createMetaConnector, type MetaConfig } from './connector.ts';
import { classifyGraphError, parseUsageHeaders } from './graph.ts';
import { META_KINDS, metaManifest } from './manifest.ts';
import { normalizeMeta, WINDOW_MS } from './normalize.ts';
import { createGraphDouble, type GraphDouble } from './testing/graph-double.ts';
import { parseMetaWebhook } from './webhooks.ts';
import { checkGraphVersion, evaluateVersions, KNOWN_VERSIONS } from './version-monitor.ts';
import fbConversation from './fixtures/fb_conversation.json' with { type: 'json' };
import fbMessage from './fixtures/fb_message.json' with { type: 'json' };
import fbComment from './fixtures/fb_comment.json' with { type: 'json' };
import fbLead from './fixtures/fb_lead.json' with { type: 'json' };
import fbReview from './fixtures/fb_review.json' with { type: 'json' };
import fbInsight from './fixtures/fb_insight.json' with { type: 'json' };
import fbMessageEvent from './fixtures/fb_message_event.json' with { type: 'json' };
import igComment from './fixtures/ig_comment.json' with { type: 'json' };
import igMedia from './fixtures/ig_media.json' with { type: 'json' };
import igDemographic from './fixtures/ig_demographic.json' with { type: 'json' };

const graph = createGraphDouble({
  conversations: 7,
  messagesPerConversation: 3,
  posts: 4,
  commentsPerPost: 3,
});
const config: MetaConfig = {
  graphOrigin: graph.origin,
  loginOrigin: 'https://www.facebook.test',
  appId: graph.appId,
};
const connector = createMetaConnector(config);

type Extra = Partial<
  Omit<Parameters<typeof createTestConnCtx<MetaConfig>>[0], 'manifest' | 'fetch' | 'config'>
>;
function pageCtx(g: GraphDouble = graph, extra: Extra = {}) {
  const token: TokenSet = {
    accessToken: g.issuePageToken(),
    refreshToken: g.issueUserToken(),
    scopes: metaManifest.scopes.map((s) => s.id),
    tokenType: 'Bearer',
    raw: { pageId: g.pageId },
    expiresAt: new Date(Date.now() + 50 * 86_400_000),
  };
  return createTestConnCtx<MetaConfig>({
    manifest: metaManifest,
    fetch: g.fetch,
    config: { ...config, graphOrigin: g.origin },
    accountExternalId: g.pageId,
    token,
    ...extra,
  });
}
function igCtx(g: GraphDouble = graph, extra: Extra = {}) {
  const ctx = pageCtx(g, { accountExternalId: g.igId, ...extra });
  return { ...ctx, platform: 'INSTAGRAM' as const };
}

const fbNormalizeCtx = createTestNormalizeCtx(metaManifest, {
  accountExternalId: graph.pageId,
  platform: 'FACEBOOK',
});
const igNormalizeCtx = createTestNormalizeCtx(metaManifest, {
  accountExternalId: graph.igId,
  platform: 'INSTAGRAM',
});

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => pageCtx(createGraphDouble({ conversations: 7, messagesPerConversation: 3 })),
    resource: 'fb.conversations',
    scenarios: {
      rateLimited: () => {
        const g = createGraphDouble();
        g.setMode('rate_limited');
        return pageCtx(g);
      },
      expiredToken: () => {
        const g = createGraphDouble();
        g.setMode('expired_token');
        return pageCtx(g);
      },
    },
    webhook: { valid: graph.messageWebhook({ text: 'hello' }), secret: graph.appSecret },
    fixtures: [
      { kind: META_KINDS.fbConversation, raw: fbConversation },
      { kind: META_KINDS.fbMessage, raw: fbMessage },
      { kind: META_KINDS.fbComment, raw: fbComment },
      { kind: META_KINDS.fbLead, raw: fbLead },
      { kind: META_KINDS.fbReview, raw: fbReview },
      { kind: META_KINDS.fbInsight, raw: fbInsight },
      { kind: META_KINDS.fbMessageEvent, raw: fbMessageEvent },
    ],
    normalizeCtx: fbNormalizeCtx,
  },
);

describe('auth and discovery', () => {
  it('exchanges the code for a long-lived user token, then discovers the Page and its Instagram account with Page tokens', async () => {
    const auth = createTestAuthCtx({
      config,
      fetch: graph.fetch,
      clientId: graph.appId,
      clientSecret: graph.appSecret,
    });
    const url = new URL(
      connector.buildAuthUrl(auth, { scopes: ['pages_show_list', 'pages_messaging'], state: 'st' }),
    );
    expect(url.pathname).toBe('/v26.0/dialog/oauth');
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_messaging');
    expect(url.searchParams.get('client_id')).toBe(graph.appId);
    const user = await connector.exchangeCode(auth, 'AQDxyz');
    expect(user.accessToken).toMatch(/^EAAB_user_/);
    expect(user.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);
    expect(user.scopes).toContain('instagram_manage_messages');
    const ctx = createTestConnCtx<MetaConfig>({
      manifest: metaManifest,
      fetch: graph.fetch,
      config,
      token: user,
    });
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts.map((a) => [a.platform, a.externalId, a.hasOwnToken])).toEqual([
      ['FACEBOOK', graph.pageId, true],
      ['INSTAGRAM', graph.igId, true],
    ]);
    expect(accounts[0]!.token!.accessToken).toMatch(/^EAAB_page_/);
    expect(accounts[1]!.parentExternalId).toBe(graph.pageId);
    expect(accounts[1]!.token!.raw).toEqual({ pageId: graph.pageId });
    // refresh re-exchanges the user token and re-reads the Page token
    const refreshed = await connector.refresh(
      { ...auth, connectionId: 'conn_1' },
      accounts[0]!.token!,
    );
    expect(refreshed.accessToken).toMatch(/^EAAB_page_/);
    expect(refreshed.accessToken).not.toBe(accounts[0]!.token!.accessToken);
    expect(refreshed.refreshToken).toMatch(/^EAAB_user_/);
    await connector.revoke(auth, refreshed);
    expect(graph.stats.revoked).toBe(1);
    await expect(
      connector.refresh({ ...auth, connectionId: 'conn_1' }, refreshed),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('classifies Graph error bodies onto the taxonomy', () => {
    expect(
      classifyGraphError(400, {
        error: { message: 'x', type: 'OAuthException', code: 190, error_subcode: 463 },
      })?.code,
    ).toBe('AUTH_EXPIRED');
    expect(classifyGraphError(400, { error: { message: 'x', code: 4 } })?.code).toBe(
      'RATE_LIMITED',
    );
    expect(classifyGraphError(403, { error: { message: 'x', code: 200 } })?.code).toBe(
      'SCOPE_MISSING',
    );
    expect(
      classifyGraphError(400, { error: { message: 'x', code: 100, error_subcode: 33 } })?.code,
    ).toBe('NOT_FOUND');
    expect(classifyGraphError(500, { error: { message: 'x', code: 1 } })?.code).toBe(
      'PLATFORM_DOWN',
    );
    expect(classifyGraphError(400, { nope: true })).toBeNull();
  });

  it('feeds usage headers into the budget and backs off at 80% of any pool', async () => {
    expect(
      parseUsageHeaders(
        { 'x-app-usage': '{"call_count":28,"total_cputime":25,"total_time":25}' },
        0,
      ).percentUsed,
    ).toBe(28);
    const buc = parseUsageHeaders(
      {
        'x-app-usage': '{"call_count":10}',
        'x-business-use-case-usage':
          '{"1":[{"type":"pages","call_count":91,"total_cputime":5,"total_time":5,"estimated_time_to_regain_access":15}]}',
      },
      1_000_000,
    );
    expect(buc.percentUsed).toBe(91);
    expect(buc.retryAfter!.getTime()).toBe(1_000_000 + 15 * 60_000);
    const g = createGraphDouble({ usagePercent: 85 });
    const delta = pageCtx(g, { lane: 'delta' });
    await connector.fetchPage(delta, { id: 'fb.mentions', since: null, highWaterMark: null });
    await expect(
      connector.fetchPage(delta, { id: 'fb.mentions', since: null, highWaterMark: null }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const interactive = pageCtx(g, { lane: 'interactive', limiter: delta.limiter });
    await expect(
      connector.fetchPage(interactive, { id: 'fb.mentions', since: null, highWaterMark: null }),
    ).resolves.toBeTruthy();
    const snap = await delta.budget.snapshot();
    expect(snap.windows[0]!.source).toBe('observed-header');
  });
});

describe('resources', () => {
  it('pages conversations with their messages and splits them into raw items', async () => {
    const ctx = pageCtx();
    const page = await connector.fetchPage(ctx, {
      id: 'fb.conversations',
      since: null,
      highWaterMark: null,
      pageSize: 3,
    });
    expect(page.items.filter((i) => i.kind === META_KINDS.fbConversation)).toHaveLength(3);
    expect(page.items.filter((i) => i.kind === META_KINDS.fbMessage)).toHaveLength(9);
    expect(page.nextCursor).toBeTruthy();
    expect(page.servedApiVersion).toBe('v26.0');
    expect(page.highWaterMark).toBeInstanceOf(Date);
    const next = await connector.fetchPage(
      ctx,
      { id: 'fb.conversations', since: null, highWaterMark: null, pageSize: 3 },
      page.nextCursor!,
    );
    expect(next.items[0]!.externalId).not.toBe(page.items[0]!.externalId);
  });

  it('covers every declared Facebook and Instagram resource', async () => {
    const fb = pageCtx();
    const ig = igCtx();
    const counts: Record<string, number> = {};
    for (const r of connector.listResources()) {
      const ctx = r.id.startsWith('ig.') ? ig : fb;
      const page = await connector.fetchPage(ctx, { id: r.id, since: null, highWaterMark: null });
      counts[r.id] = page.items.length;
      for (const item of page.items)
        expect(r.kinds, `${r.id} yielded ${item.kind}`).toContain(item.kind);
    }
    expect(counts).toMatchObject({
      'fb.comments': 16,
      'fb.mentions': 1,
      'fb.reviews': 2,
      'fb.leads': 1,
      'fb.insights': 5,
      'ig.comments': 20,
      'ig.mentions': 1,
      'ig.insights': 4,
      'ig.followers': 1,
    });
  });

  it('subscribes the Page to the webhook fields the enabled resources need', async () => {
    const g = createGraphDouble();
    await connector.subscribeWebhooks(pageCtx(g), ['fb.conversations', 'fb.comments', 'fb.leads']);
    expect(g.stats.subscribedFields.sort()).toEqual([
      'feed',
      'leadgen',
      'messages',
      'messaging_postbacks',
    ]);
  });
});

describe('normalize', () => {
  it('turns a conversation and its messages into person, conversation and dm messages keyed by the customer', () => {
    const conv = normalizeMeta(META_KINDS.fbConversation, fbConversation, fbNormalizeCtx);
    expect(conv.map((e) => e.kind)).toEqual(['person', 'conversation']);
    expect(conv[1]).toMatchObject({ externalId: 'dm:24100000001', conversationType: 'dm' });
    const msg = normalizeMeta(META_KINDS.fbMessage, fbMessage, fbNormalizeCtx);
    expect(msg.map((e) => e.kind)).toEqual(['person', 'message']);
    expect(msg[1]).toMatchObject({
      conversationExternalId: 'dm:24100000001',
      direction: 'inbound',
      messageType: 'dm',
    });
    expect((msg[1] as { replyWindowExpiresAt: Date }).replyWindowExpiresAt.getTime()).toBe(
      new Date('2026-09-20T14:03:11+0000').getTime() + WINDOW_MS,
    );
    expect((msg[1] as { attachments: unknown[] }).attachments).toHaveLength(1);
    const own = normalizeMeta(
      META_KINDS.fbMessage,
      {
        ...fbMessage,
        from: { id: graph.pageId, name: 'Acme' },
        to: { data: [{ id: '24100000001' }] },
      },
      fbNormalizeCtx,
    );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ direction: 'outbound' });
    expect((own[0] as { replyWindowExpiresAt?: Date }).replyWindowExpiresAt).toBeUndefined();
    expect(
      normalizeMeta(META_KINDS.fbMessageEvent, fbMessageEvent, fbNormalizeCtx).map((e) => e.kind),
    ).toEqual(['person', 'conversation', 'message']);
    expect(
      normalizeMeta(META_KINDS.fbMessageEvent, fbMessageEvent, fbNormalizeCtx)[2],
    ).toMatchObject({
      conversationExternalId: 'dm:24100000001',
      externalId: 'm_wh_0001',
      body: 'Do you deliver on Saturdays?',
    });
  });

  it('matches golden snapshots for every kind', () => {
    const cases: [string, unknown, typeof fbNormalizeCtx][] = [
      [META_KINDS.fbConversation, fbConversation, fbNormalizeCtx],
      [META_KINDS.fbMessage, fbMessage, fbNormalizeCtx],
      [META_KINDS.fbComment, fbComment, fbNormalizeCtx],
      [META_KINDS.fbLead, fbLead, fbNormalizeCtx],
      [META_KINDS.fbReview, fbReview, fbNormalizeCtx],
      [META_KINDS.fbInsight, fbInsight, fbNormalizeCtx],
      [META_KINDS.fbMessageEvent, fbMessageEvent, fbNormalizeCtx],
      [META_KINDS.igComment, igComment, igNormalizeCtx],
      [META_KINDS.igMedia, igMedia, igNormalizeCtx],
      [META_KINDS.igDemographic, igDemographic, igNormalizeCtx],
    ];
    for (const [kind, raw, ctx] of cases)
      expect(normalizeMeta(kind, raw, ctx), kind).toMatchSnapshot();
  });

  it('rejects drifted shapes', () => {
    expect(() =>
      normalizeMeta(
        META_KINDS.fbMessage,
        { ...fbMessage, created_time: 'yesterday' },
        fbNormalizeCtx,
      ),
    ).toThrow(NexusError);
    expect(() =>
      normalizeMeta(
        META_KINDS.fbConversation,
        { ...fbConversation, participants: { data: [{ id: graph.pageId }] } },
        fbNormalizeCtx,
      ),
    ).toThrow(/customer/);
    expect(() => normalizeMeta('fb_unknown', {}, fbNormalizeCtx)).toThrow(/unknown kind/);
  });
});

describe('webhooks', () => {
  it('verifies the signature and splits all six topics into envelopes routed by the entry id', () => {
    const dm = graph.messageWebhook({ text: 'hey' });
    expect(connector.verifyWebhook(dm, graph.appSecret)).toBe(true);
    expect(connector.verifyWebhook(dm, 'wrong')).toBe(false);
    const [env] = parseMetaWebhook(dm);
    expect(env).toMatchObject({
      kind: META_KINDS.fbMessageEvent,
      connectionHint: { platform: 'FACEBOOK', accountExternalId: graph.pageId },
    });
    expect(parseMetaWebhook(graph.commentWebhook({ text: 'nice' }))[0]).toMatchObject({
      kind: META_KINDS.fbFeedChange,
      connectionHint: { platform: 'FACEBOOK' },
    });
    expect(parseMetaWebhook(graph.leadgenWebhook('lead_9'))[0]).toMatchObject({
      kind: META_KINDS.fbLeadgenEvent,
      externalId: 'lead_9',
    });
    expect(parseMetaWebhook(graph.igCommentWebhook({ text: 'ig!' }))[0]).toMatchObject({
      kind: META_KINDS.igComment,
      connectionHint: { platform: 'INSTAGRAM', accountExternalId: graph.igId },
    });
    expect(parseMetaWebhook(graph.igMentionWebhook())[0]).toMatchObject({
      kind: META_KINDS.igMention,
    });
    expect(parseMetaWebhook(graph.messageWebhook({ text: 'ig dm', ig: true }))[0]).toMatchObject({
      kind: META_KINDS.igMessageEvent,
      connectionHint: { platform: 'INSTAGRAM' },
    });
    expect(
      parseMetaWebhook({
        ...dm,
        rawBody:
          '{"object":"page","entry":[{"id":"1","changes":[{"field":"feed","value":{"item":"like","verb":"add"}}]}]}',
      }),
    ).toEqual([]);
    // the webhook and a poll of the same thread agree on the conversation id
    const fromWebhook = normalizeMeta(env!.kind, env!.raw, fbNormalizeCtx).find(
      (e) => e.kind === 'message',
    )!;
    expect(fromWebhook).toMatchObject({
      conversationExternalId: `dm:${graph.conversations[0]!.psid}`,
    });
  });
});

describe('outbound and the 24-hour window', () => {
  const action = (over: Partial<Parameters<typeof connector.preflight>[1]> = {}) => ({
    id: 'oa',
    kind: 'reply_dm' as const,
    conversationExternalId: `dm:${graph.conversations[0]!.psid}`,
    payload: { text: 'On its way!' },
    idempotencyKey: 'k',
    requestNonce: 'n',
    requestedByUserId: 'u',
    ...over,
  });

  it('allows a reply inside the window, warns near its end and blocks at 24h+1m with the closing time', async () => {
    const ctx = pageCtx();
    const now = Date.now();
    expect(
      await connector.preflight(
        ctx,
        action({ context: { lastInboundAt: new Date(now - 3600_000) } }),
      ),
    ).toEqual({ ok: true, warnings: [] });
    const near = await connector.preflight(
      ctx,
      action({ context: { lastInboundAt: new Date(now - (WINDOW_MS - 20 * 60_000)) } }),
    );
    expect(near).toMatchObject({ ok: true });
    expect((near as { warnings: string[] }).warnings[0]).toMatch(/closes in \d+ minutes/);
    const closed = await connector.preflight(
      ctx,
      action({ context: { lastInboundAt: new Date(now - WINDOW_MS - 60_000) } }),
    );
    expect(closed).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    expect((closed as { reason: string }).reason).toMatch(
      /24-hour messaging window closed at 20\d\d-/,
    );
    expect(
      await connector.preflight(ctx, action({ context: { lastInboundAt: null } })),
    ).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    expect(
      await connector.preflight(
        ctx,
        action({ payload: { text: '   ' }, context: { lastInboundAt: new Date() } }),
      ),
    ).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await connector.preflight(ctx, action({ kind: 'publish_post' }))).toMatchObject({
      ok: false,
      code: 'POLICY_BLOCKED',
    });
  });

  it('blocks on missing scope with the permission name', async () => {
    const g = createGraphDouble();
    const ctx = pageCtx(g, {
      token: {
        accessToken: g.issuePageToken(),
        scopes: ['pages_show_list'],
        tokenType: 'Bearer',
        raw: { pageId: g.pageId },
      },
    });
    const r = await connector.preflight(ctx, action({ context: { lastInboundAt: new Date() } }));
    expect(r).toMatchObject({ ok: false, code: 'SCOPE_MISSING' });
    expect((r as { reason: string }).reason).toContain('pages_messaging');
  });

  it('sends DMs, replies to comments, hides and deletes, and honours dry-run', async () => {
    const g = createGraphDouble();
    const ctx = pageCtx(g);
    const sent = await connector.execute(ctx, action());
    expect(sent.externalId).toMatch(/^m_out_/);
    expect(g.stats.sent[0]).toMatchObject({ psid: g.conversations[0]!.psid, text: 'On its way!' });
    const reply = await connector.execute(ctx, {
      ...action(),
      kind: 'reply_comment',
      targetExternalId: '5000_9000',
      payload: { text: 'DM sent' },
    });
    expect(reply.externalId).toMatch(/^5000_9000_reply_/);
    await connector.execute(ctx, {
      ...action(),
      kind: 'hide_comment',
      targetExternalId: '5000_9000',
    });
    await connector.execute(ctx, {
      ...action(),
      kind: 'delete_comment',
      targetExternalId: '5000_9001',
    });
    expect(g.stats.hidden).toEqual(['5000_9000']);
    expect(g.stats.deleted).toEqual(['5000_9001']);
    const ig = igCtx(g);
    const igReply = await connector.execute(ig, {
      ...action(),
      kind: 'reply_comment',
      targetExternalId: '17990000000000001',
      payload: { text: 'thanks' },
    });
    expect(igReply.externalId).toContain('17990000000000001_reply_');
    const dry = pageCtx(g, { settings: { dryRun: true } });
    expect((await connector.execute(dry, action())).externalId).toMatch(/^dry_/);
    expect(g.stats.sent).toHaveLength(1);
    await expect(
      connector.execute(ctx, action({ conversationExternalId: 'dm:0000' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('health and version drift', () => {
  it('reports a healthy Page and flags a silently downgraded served version as SCHEMA_DRIFT', async () => {
    const ok = await connector.health(pageCtx());
    expect(ok.status).toBe('healthy');
    const drifted = createGraphDouble({ servedVersion: 'v25.0' });
    const report = await connector.health(pageCtx(drifted));
    expect(report.status).toBe('degraded');
    expect(report.checks.find((c) => c.id === 'api_version')).toMatchObject({
      ok: false,
      failureClass: 'SCHEMA_DRIFT',
    });
    const expired = createGraphDouble();
    expired.setMode('expired_token');
    expect((await connector.health(pageCtx(expired))).status).toBe('reconnect_required');
  });

  it('evaluates the sunset schedule and opens an upgrade window 180 days out', () => {
    const at = (s: string) => new Date(s);
    expect(evaluateVersions('v26.0', KNOWN_VERSIONS, at('2026-09-25'))).toMatchObject({
      action: 'ok',
      latest: 'v26.0',
      behind: 0,
      sunsetSource: 'unknown',
    });
    const withNext = [
      ...KNOWN_VERSIONS,
      { version: 'v27.0', released: at('2026-11-10'), sunset: null },
    ];
    const est = evaluateVersions('v26.0', withNext, at('2028-06-01'));
    expect(est).toMatchObject({ action: 'plan_upgrade', sunsetSource: 'estimated', behind: 1 });
    expect(est.sunsetAt!.toISOString().slice(0, 10)).toBe('2028-11-09');
    expect(evaluateVersions('v26.0', withNext, at('2028-10-20')).action).toBe('urgent');
    expect(evaluateVersions('v19.0', KNOWN_VERSIONS, at('2026-09-25'))).toMatchObject({
      action: 'urgent',
      sunsetSource: 'published',
    });
    expect(evaluateVersions('v99.0', KNOWN_VERSIONS, at('2026-09-25')).action).toBe(
      'unknown_version',
    );
  });

  it('merges a feed over the built-in table and survives a broken feed', async () => {
    const good = await checkGraphVersion({
      pinned: 'v26.0',
      now: new Date('2026-09-25'),
      feedUrl: 'https://feed.test/versions.json',
      fetch: async () => ({
        ok: true,
        json: async () => ({
          versions: [{ version: 'v26.0', released: '2026-07-29', sunset: '2027-01-15' }],
        }),
      }),
    });
    expect(good.feed).toBe('used');
    expect(good).toMatchObject({ action: 'plan_upgrade', sunsetSource: 'published' });
    const bad = await checkGraphVersion({
      pinned: 'v26.0',
      now: new Date('2026-09-25'),
      feedUrl: 'https://feed.test/versions.json',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(bad.feed).toBe('unavailable');
    expect(bad.action).toBe('ok');
  });
});
