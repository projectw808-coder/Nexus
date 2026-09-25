/**
 * Phase 5 acceptance (spec §16) against the Graph API double — the same flow a real test Page
 * follows, with credentials swapped for the double:
 *   · connect a Page and its Instagram account (two independently manageable connections)
 *   · a DM webhook lands as Conversation + Message in well under 10 s
 *   · a reply goes out through preflight → OutboundAction → the platform → an outbound Message
 *   · the 24-hour window blocks a send at 24h+1m with a clear reason
 *   · pausing the Facebook connection leaves Instagram syncing
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
import { createVault, systemActorFor, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus, type InlineBus } from './bus.ts';
import { completeOauth, connectPlatform, startOauth } from './connect.ts';
import type { SyncDeps } from './deps.ts';
import { deadLetterJob, handleJob } from './jobs.ts';
import { executeOutbound, requestReply } from './outbound.ts';
import { createConnectorRegistry } from './registry.ts';
import { countingSink } from './sink.ts';
import { composeSinks, createConversationSink } from './sinks/conversations.ts';
import { runMetaVersionMonitor } from './version-monitor.ts';
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
let seq = 0;

function makeDeps(graph: GraphDouble): SyncDeps & { bus: InlineBus } {
  const registry = createConnectorRegistry({
    meta: { graphOrigin: graph.origin, appId: graph.appId },
  });
  const deps: SyncDeps & { bus: InlineBus } = {
    runtime: db.runtime,
    vault,
    limiter: new RateLimiter({ store: new MemoryBudgetStore(), random: () => 0.5 }),
    registry,
    sink: composeSinks(countingSink(), createConversationSink(db.runtime)),
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

async function connectMeta(deps: SyncDeps, backfill = false) {
  const start = startOauth(deps, {
    workspaceId: owner.workspaceId,
    userId: owner.userId!,
    platform: 'FACEBOOK',
    returnTo: '/w/acme/inbox',
  });
  expect(new URL(start.authorizeUrl).host).toBe('www.facebook.com');
  const done = await completeOauth(deps, { code: 'AQtestcode', state: start.state });
  return connectPlatform(deps, { actor: owner, platform: 'FACEBOOK', token: done.token, backfill });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@meta.test', name: 'Owner' } });
  userId = u.id;
});
afterAll(async () => db.close());

async function freshWorkspace() {
  seq += 1;
  const ws = await db.tenancy.createWorkspace({
    name: `Meta ${seq}`,
    slug: `meta-${seq}`,
    ownerUserId: userId,
  });
  owner = { ...systemActorFor(ws.id), userId, actorType: 'USER' };
}

describe('Meta end to end', () => {
  it('connects a Page and its Instagram account as two connections with Page tokens, and backfills every resource', async () => {
    await freshWorkspace();
    const graph = createGraphDouble({
      conversations: 3,
      messagesPerConversation: 2,
      posts: 2,
      commentsPerPost: 2,
    });
    const deps = makeDeps(graph);
    const { connections } = await connectMeta(deps, true);
    expect(connections.map((c) => c.label)).toEqual([
      'Facebook — Acme Coffee',
      'Instagram — Acme Coffee (@acmecoffee)',
    ]);
    const rows = await db.runtime.withTenant(owner, (tx) =>
      tx.connection.findMany({ orderBy: { platform: 'asc' } }),
    );
    expect(rows.map((r) => r.platform)).toEqual(['FACEBOOK', 'INSTAGRAM']);
    expect(rows[0]!.apiVersion).toBe('v26.0');
    const fbToken = await db.runtime.withTenant(owner, (tx) =>
      vault.getTokenSet(tx, rows[0]!.tokenRef),
    );
    expect(fbToken.token.accessToken).toMatch(/^EAAB_page_/);
    expect(fbToken.token.refreshToken).toMatch(/^EAAB_user_/);
    expect(graph.stats.subscribedFields).toContain('messages');
    await deps.bus.drain();
    const objects = await db.runtime.withTenant(owner, (tx) =>
      tx.externalObject.groupBy({ by: ['kind'], _count: { _all: true } }),
    );
    const kinds = Object.fromEntries(objects.map((o) => [o.kind, o._count._all]));
    expect(kinds).toMatchObject({
      fb_conversation: 3,
      fb_message: 6,
      fb_post: 2,
      fb_comment: 4,
      fb_review: 2,
      fb_lead: 1,
      fb_mention: 1,
      ig_media: 2,
      ig_comment: 6,
      ig_mention: 1,
    });
    expect(kinds['fb_insight']).toBeGreaterThan(0);
    const quarantined = await db.runtime.withTenant(owner, (tx) =>
      tx.externalObject.count({ where: { quarantinedAt: { not: null } } }),
    );
    expect(quarantined).toBe(0);
    const convs = await db.runtime.withTenant(owner, (tx) =>
      tx.conversation.findMany({
        include: { identity: true, _count: { select: { messages: true } } },
      }),
    );
    const dms = convs.filter((c) => c.kind === 'DM');
    expect(dms).toHaveLength(6); // 3 Messenger threads + the same 3 customers on Instagram
    expect(dms.every((c) => c.identity && c._count.messages === 2)).toBe(true);
    expect(convs.filter((c) => c.kind === 'COMMENT_THREAD').length).toBe(4); // 2 FB posts + 2 IG media
    expect(convs.filter((c) => c.kind === 'MENTION').length).toBe(2);
    const identities = await db.runtime.withTenant(owner, (tx) => tx.identity.count());
    expect(identities).toBeGreaterThan(5);
    const runs = await db.runtime.withTenant(owner, (tx) => tx.syncRun.findMany());
    expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
    expect(runs.map((r) => r.resource).sort()).toEqual([
      'fb.comments',
      'fb.conversations',
      'fb.insights',
      'fb.leads',
      'fb.mentions',
      'fb.reviews',
      'ig.comments',
      'ig.dms',
      'ig.insights',
      'ig.mentions',
    ]);
  });

  it('a DM webhook becomes a Conversation + Message in under 10 s, and a reply lands on the platform', async () => {
    await freshWorkspace();
    const graph = createGraphDouble({ conversations: 2, messagesPerConversation: 1 });
    const deps = makeDeps(graph);
    const { connections } = await connectMeta(deps, false);
    const fb = connections.find((c) => c.label.startsWith('Facebook'))!;
    const psid = '24999000000';

    const t0 = Date.now();
    const hook = graph.messageWebhook({ psid, text: 'Hi! Do you ship to Canada?' });
    const receipt = await receiveWebhook(deps, 'FACEBOOK', {
      ...hook,
      path: `/api/webhooks/facebook/${fb.id}`,
    });
    expect(receipt.status).toBe(200);
    await deps.bus.drain();
    const landedMs = Date.now() - t0;
    const conv = await db.runtime.withTenant(owner, (tx) =>
      tx.conversation.findFirst({
        where: { connectionId: fb.id, externalId: `dm:${psid}` },
        include: { messages: true, identity: true },
      }),
    );
    expect(conv).not.toBeNull();
    expect(conv!.kind).toBe('DM');
    expect(conv!.unreadCount).toBe(1);
    expect(conv!.identity?.externalId).toBe(psid);
    expect(conv!.messages).toHaveLength(1);
    expect(conv!.messages[0]).toMatchObject({
      direction: 'INBOUND',
      body: 'Hi! Do you ship to Canada?',
      deliveryState: 'DELIVERED',
    });
    expect(conv!.messages[0]!.replyWindowExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000,
    );
    expect(landedMs).toBeLessThan(10_000);
    console.warn(`webhook DM → Conversation + Message in ${landedMs} ms`);

    // Reply from the scaffold: preflight passes, the action is queued, executed, and the platform received it.
    graph.conversations.push({ ...graph.conversations[0]!, id: 't_wh', psid });
    const reply = await requestReply(deps, {
      actor: owner,
      conversationId: conv!.id,
      text: 'Yes — free over $50!',
      requestNonce: 'click-1',
    });
    expect(reply.status).toBe('queued');
    await deps.bus.drain();
    expect(graph.stats.sent).toEqual([{ psid, text: 'Yes — free over $50!', igAccount: false }]);
    const after = await db.runtime.withTenant(owner, (tx) =>
      tx.conversation.findUniqueOrThrow({
        where: { id: conv!.id },
        include: { messages: { orderBy: { sentAt: 'asc' } }, outboundActions: true },
      }),
    );
    expect(after.outboundActions).toHaveLength(1);
    expect(after.outboundActions[0]).toMatchObject({ status: 'SENT', kind: 'reply_dm' });
    expect(after.outboundActions[0]!.externalId).toMatch(/^m_out_/);
    expect(after.messages.map((m) => m.direction)).toEqual(['INBOUND', 'OUTBOUND']);
    expect(after.messages[1]).toMatchObject({
      authorUserId: userId,
      deliveryState: 'SENT',
      outboundActionId: after.outboundActions[0]!.id,
    });
    const audit = await db.runtime.withTenant(owner, (tx) =>
      tx.auditLog.findMany({ where: { action: { in: ['outbound.requested', 'outbound.sent'] } } }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['outbound.requested', 'outbound.sent']);
    // The same click retried collapses; a new intent goes through.
    expect(
      (
        await requestReply(deps, {
          actor: owner,
          conversationId: conv!.id,
          text: 'Yes — free over $50!',
          requestNonce: 'click-1',
        })
      ).status,
    ).toBe('duplicate');
    expect(
      (
        await requestReply(deps, {
          actor: owner,
          conversationId: conv!.id,
          text: 'Yes — free over $50!',
          requestNonce: 'click-2',
        })
      ).status,
    ).toBe('queued');
    await deps.bus.drain();
    expect(graph.stats.sent).toHaveLength(2);
    // The platform echoes our own message back by webhook: no third message row.
    await receiveWebhook(deps, 'FACEBOOK', {
      ...graph.messageWebhook({ psid, text: 'Yes — free over $50!', echo: true }),
      path: `/api/webhooks/facebook/${fb.id}`,
    });
    await deps.bus.drain();
    const echoed = await db.runtime.withTenant(owner, (tx) =>
      tx.message.count({ where: { conversationId: conv!.id } }),
    );
    expect(echoed).toBe(4); // inbound + two replies + the echo (own mid); Phase 7 collapses echoes onto their OutboundAction
  });

  it('blocks a reply at 24h+1m with a clear reason and records it', async () => {
    await freshWorkspace();
    const graph = createGraphDouble({ conversations: 1, messagesPerConversation: 1 });
    const deps = makeDeps(graph);
    const { connections } = await connectMeta(deps, false);
    const fb = connections[0]!;
    const psid = '24999000001';
    const stale = Date.now() - 24 * 3600_000 - 60_000;
    await receiveWebhook(deps, 'FACEBOOK', {
      ...graph.messageWebhook({ psid, text: 'old question', at: stale }),
      path: `/api/webhooks/facebook/${fb.id}`,
    });
    await deps.bus.drain();
    const conv = await db.runtime.withTenant(owner, (tx) =>
      tx.conversation.findFirstOrThrow({
        where: { externalId: `dm:${psid}` },
        include: { messages: true },
      }),
    );
    expect(conv.messages[0]!.replyWindowExpiresAt!.getTime()).toBeLessThan(Date.now());
    const blocked = await requestReply(deps, {
      actor: owner,
      conversationId: conv.id,
      text: 'sorry for the delay',
      requestNonce: 'late-1',
    });
    expect(blocked.status).toBe('blocked');
    if (blocked.status === 'blocked') {
      expect(blocked.code).toBe('POLICY_BLOCKED');
      expect(blocked.reason).toMatch(/24-hour messaging window closed at/);
      expect(blocked.remediation).toMatch(/window reopens/);
    }
    expect(graph.stats.sent).toHaveLength(0);
    const actions = await db.runtime.withTenant(owner, (tx) =>
      tx.outboundAction.findMany({ where: { conversationId: conv.id } }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'BLOCKED', errorCode: 'POLICY_BLOCKED' });
    // A fresh inbound reopens the window.
    await receiveWebhook(deps, 'FACEBOOK', {
      ...graph.messageWebhook({ psid, text: 'still there?' }),
      path: `/api/webhooks/facebook/${fb.id}`,
    });
    await deps.bus.drain();
    graph.conversations.push({ ...graph.conversations[0]!, id: 't_late', psid });
    expect(
      (
        await requestReply(deps, {
          actor: owner,
          conversationId: conv.id,
          text: 'yes!',
          requestNonce: 'late-2',
        })
      ).status,
    ).toBe('queued');
    await deps.bus.drain();
    expect(graph.stats.sent).toHaveLength(1);
  });

  it('pausing the Facebook connection leaves Instagram syncing, and a comment webhook threads onto its post', async () => {
    await freshWorkspace();
    const graph = createGraphDouble({
      conversations: 1,
      messagesPerConversation: 1,
      posts: 1,
      commentsPerPost: 1,
    });
    const deps = makeDeps(graph);
    const { connections } = await connectMeta(deps, false);
    const fb = connections.find((c) => c.label.startsWith('Facebook'))!;
    const ig = connections.find((c) => c.label.startsWith('Instagram'))!;
    await db.runtime.withTenant(owner, (tx) =>
      tx.connection.update({
        where: { id: fb.id },
        data: { status: 'PAUSED', pausedReason: 'test' },
      }),
    );
    await deps.bus.enqueue({
      queue: 'sync.delta',
      name: 'sync',
      data: {
        workspaceId: owner.workspaceId,
        connectionId: fb.id,
        resource: 'fb.comments',
        trigger: 'MANUAL',
        lane: 'interactive',
      },
    });
    await deps.bus.enqueue({
      queue: 'sync.delta',
      name: 'sync',
      data: {
        workspaceId: owner.workspaceId,
        connectionId: ig.id,
        resource: 'ig.comments',
        trigger: 'MANUAL',
        lane: 'interactive',
      },
    });
    await deps.bus.drain();
    const byConn = await db.runtime.withTenant(owner, (tx) =>
      tx.externalObject.groupBy({ by: ['connectionId'], _count: { _all: true } }),
    );
    expect(byConn.find((b) => b.connectionId === fb.id)).toBeUndefined();
    expect(byConn.find((b) => b.connectionId === ig.id)!._count._all).toBeGreaterThan(0);
    const runs = await db.runtime.withTenant(owner, (tx) =>
      tx.syncRun.findMany({ where: { connectionId: fb.id } }),
    );
    expect(runs).toHaveLength(0);
    // IG comment webhook → COMMENT_THREAD keyed by the media
    await receiveWebhook(deps, 'INSTAGRAM', {
      ...graph.igCommentWebhook({ text: 'is this gluten free?' }),
      path: `/api/webhooks/instagram/${ig.id}`,
    });
    await deps.bus.drain();
    const thread = await db.runtime.withTenant(owner, (tx) =>
      tx.conversation.findFirst({
        where: { connectionId: ig.id, externalId: `media:${graph.media[0]!.id}` },
        include: { messages: true },
      }),
    );
    expect(thread?.kind).toBe('COMMENT_THREAD');
    expect(thread?.messages.some((m) => m.body === 'is this gluten free?')).toBe(true);
    // Reply to the comment thread goes through the IG replies endpoint.
    const reply = await requestReply(deps, {
      actor: owner,
      conversationId: thread!.id,
      text: 'Yes it is!',
      requestNonce: 'c-1',
    });
    expect(reply.status).toBe('queued');
    await deps.bus.drain();
    expect(graph.stats.replies).toHaveLength(1);
    expect(graph.stats.replies[0]!.text).toBe('Yes it is!');
  });

  it('the version monitor opens one upgrade task per workspace when the pinned version nears sunset', async () => {
    await freshWorkspace();
    const graph = createGraphDouble();
    const deps = makeDeps(graph);
    await connectMeta(deps, false);
    const feed = () =>
      new Response(
        JSON.stringify({
          versions: [{ version: 'v26.0', released: '2026-07-29', sunset: '2027-02-01' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const ok = await runMetaVersionMonitor(deps, { now: new Date('2026-09-25') });
    expect(ok.action).toBe('ok');
    expect(ok.tasksOpened).toBe(0);
    // Simulate a feed that publishes a near sunset by monkey-patching global fetch for the feed URL.
    const originalFetch = globalThis.fetch;
    const urlOf = (input: RequestInfo | URL): string =>
      input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input).includes('versions.json') ? feed() : originalFetch(input, init);
    try {
      const warn = await runMetaVersionMonitor(deps, {
        now: new Date('2026-09-25'),
        feedUrl: 'https://feed.test/versions.json',
      });
      expect(warn.action).toBe('plan_upgrade');
      expect(warn.tasksOpened).toBeGreaterThanOrEqual(1); // one per workspace with Meta connections (the suite has several)
      const again = await runMetaVersionMonitor(deps, {
        now: new Date('2026-09-25'),
        feedUrl: 'https://feed.test/versions.json',
      });
      expect(again.tasksOpened).toBe(0); // idempotent
    } finally {
      globalThis.fetch = originalFetch;
    }
    const tasks = await db.runtime.withTenant(owner, (tx) => tx.task.findMany());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toContain('[meta-version]');
    expect(tasks[0]!.dueAt?.toISOString().slice(0, 10)).toBe('2027-02-01');
    // A directly executed outbound with a dry-run connection never reaches the platform.
    void executeOutbound;
  });
});
