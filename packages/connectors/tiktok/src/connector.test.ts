import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import { createTestConnCtx, createTestNormalizeCtx } from '@nexus/connector-sdk/testing';
import type { OutboundActionInput } from '@nexus/connector-sdk';
import { createTikTokConnector, WINDOW_MS, type TikTokConfig } from './connector.ts';
import { tiktokManifest, KINDS } from './manifest.ts';
import {
  createTikTokDouble,
  dmFixture,
  leadFixture,
  tiktokWebhookRequest,
} from './testing/tiktok-double.ts';
import tiktokVideo from './fixtures/tiktok_video.json' with { type: 'json' };
import tiktokVideoDrift from './fixtures/tiktok_video.drift.json' with { type: 'json' };
import tiktokComment from './fixtures/tiktok_comment.json' with { type: 'json' };
import tiktokDm from './fixtures/tiktok_dm.json' with { type: 'json' };
import tiktokLead from './fixtures/tiktok_lead.json' with { type: 'json' };

const FULL_SCOPES = [
  'user.info.basic',
  'video.list',
  'video.comment.list',
  'video.comment.manage',
  'biz.dm.read',
  'biz.dm.send',
  'leads.retrieval',
];

const connector = createTikTokConnector({});

function ctxFor(
  double: ReturnType<typeof createTikTokDouble>,
  extra: Partial<Parameters<typeof createTestConnCtx<TikTokConfig>>[0]> = {},
) {
  return createTestConnCtx<TikTokConfig>({
    manifest: tiktokManifest,
    fetch: double.fetch,
    config: {},
    accountExternalId: double.businessAccountId,
    token: {
      accessToken: double.accessToken,
      refreshToken: double.refreshToken,
      scopes: FULL_SCOPES,
      tokenType: 'Bearer',
      raw: {},
    },
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

// ── The SDK contract suite ──
const shared = createTikTokDouble({ totalComments: 23, pageSize: 5 });
const webhookDm = dmFixture(99, { message_id: 'msg_webhook_99' });
const webhookSample = tiktokWebhookRequest({
  path: '/api/webhooks/tiktok/conn_test',
  event: 'message.receive',
  content: webhookDm,
  secret: shared.webhookSecret,
});

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(shared),
    resource: 'tiktok.comments',
    scenarios: {
      rateLimited: () => ctxFor(createTikTokDouble({ forceStatus: 429 })),
      expiredToken: () => ctxFor(createTikTokDouble({ forceStatus: 401 })),
    },
    webhook: { valid: webhookSample, secret: shared.webhookSecret },
    fixtures: [
      { kind: KINDS.video, raw: tiktokVideo },
      { kind: KINDS.comment, raw: tiktokComment },
      { kind: KINDS.dm, raw: tiktokDm },
      { kind: KINDS.lead, raw: tiktokLead },
    ],
    normalizeCtx: createTestNormalizeCtx(tiktokManifest, {
      accountExternalId: shared.businessAccountId,
    }),
  },
);

// ── TikTok-specific behaviour ──
describe('TikTok connector', () => {
  describe('provider capability matrix (§ two-provider design)', () => {
    it('business (default) exposes the full manifest capability set when every scope is granted', async () => {
      const ctx = ctxFor(shared);
      const caps = await connector.capabilities(ctx);
      expect([...caps].sort()).toEqual([...tiktokManifest.capabilities].sort());
    });

    it('display excludes messaging, leads and comment-write even with every scope granted', async () => {
      const ctx = ctxFor(shared, { config: { provider: 'display' } });
      const caps = await connector.capabilities(ctx);
      expect([...caps].sort()).toEqual(['read:followers', 'read:posts', 'read:profile'].sort());
      for (const forbidden of [
        'read:messages',
        'write:reply_dm',
        'read:leads',
        'read:comments',
        'write:reply_comment',
        'write:hide_comment',
        'write:delete_comment',
      ] as const) {
        expect(caps).not.toContain(forbidden);
      }
    });

    it('business still degrades individual capabilities when their scope is missing', async () => {
      const ctx = ctxFor(shared, {
        token: {
          accessToken: shared.accessToken,
          scopes: ['user.info.basic', 'video.list'],
          tokenType: 'Bearer',
          raw: {},
        },
      });
      const caps = await connector.capabilities(ctx);
      expect(caps).toEqual(['read:posts', 'read:profile', 'read:followers']);
    });
  });

  describe('Business Messaging 48-hour window preflight', () => {
    const replyAction = (context: { lastInboundAt: Date | null }): OutboundActionInput => ({
      id: 'oa_1',
      kind: 'reply_dm',
      conversationExternalId: `dm:${shared.dms[0]!.from_user_id}`,
      payload: { text: 'Thanks for reaching out!' },
      idempotencyKey: 'k-1',
      requestNonce: 'n-1',
      requestedByUserId: 'u1',
      context,
    });

    it('blocks when the window has never opened (no inbound message on record)', async () => {
      const ctx = ctxFor(shared);
      const result = await connector.preflight(ctx, replyAction({ lastInboundAt: null }));
      expect(result).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
      expect((result as { reason: string }).reason).toMatch(/never opened/);
    });

    it('allows with no warning when the window has plenty of time left', async () => {
      const ctx = ctxFor(shared);
      const lastInboundAt = new Date(Date.now() - 3600_000); // 1h ago of 48h — 47h left
      const result = await connector.preflight(ctx, replyAction({ lastInboundAt }));
      expect(result).toEqual({ ok: true, warnings: [] });
    });

    it('allows but warns when under an hour remains before the window closes', async () => {
      const ctx = ctxFor(shared);
      const lastInboundAt = new Date(Date.now() - (WINDOW_MS - 30 * 60_000)); // ~30 min left
      const result = await connector.preflight(ctx, replyAction({ lastInboundAt }));
      expect(result.ok).toBe(true);
      const warnings = (result as { ok: true; warnings: string[] }).warnings;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/closes in/);
    });

    it('blocks with the exact closing timestamp once the window has expired', async () => {
      const ctx = ctxFor(shared);
      const lastInboundAt = new Date(Date.now() - (WINDOW_MS + 3600_000)); // expired 1h ago
      const result = await connector.preflight(ctx, replyAction({ lastInboundAt }));
      expect(result).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
      const expires = new Date(lastInboundAt.getTime() + WINDOW_MS);
      expect((result as { reason: string }).reason).toContain(expires.toISOString());
    });
  });

  describe('DM sending is a real implementation, not "unsupported"', () => {
    it('executes an actual send once the window is open, and is idempotent on retry', async () => {
      const ctx = ctxFor(shared);
      const action: OutboundActionInput = {
        id: 'oa_2',
        kind: 'reply_dm',
        conversationExternalId: `dm:${shared.dms[0]!.from_user_id}`,
        payload: { text: 'Yes, we ship worldwide!' },
        idempotencyKey: 'k-send-1',
        requestNonce: 'n-2',
        requestedByUserId: 'u1',
        context: { lastInboundAt: new Date() },
      };
      const preflight = await connector.preflight(ctx, action);
      expect(preflight.ok).toBe(true);
      const result = await connector.execute(ctx, action);
      expect(result.externalId).toMatch(/^msg_sent_/);
      expect(result.sentAt).toBeInstanceOf(Date);
      expect(shared.stats.sends).toBeGreaterThan(0);
      const again = await connector.execute(ctx, action);
      expect(again.externalId).toBe(result.externalId);
    });
  });

  describe('Business-only actions refuse on the Display provider', () => {
    const displayCtx = () => ctxFor(shared, { config: { provider: 'display' } });

    it('preflight refuses reply_dm', async () => {
      const result = await connector.preflight(displayCtx(), {
        id: 'oa_3',
        kind: 'reply_dm',
        payload: { text: 'hi' },
        idempotencyKey: 'k',
        requestNonce: 'n',
        requestedByUserId: 'u1',
      });
      expect(result).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    });

    it('preflight refuses hide_comment', async () => {
      const result = await connector.preflight(displayCtx(), {
        id: 'oa_4',
        kind: 'hide_comment',
        targetExternalId: 'comment_1',
        payload: {},
        idempotencyKey: 'k',
        requestNonce: 'n',
        requestedByUserId: 'u1',
      });
      expect(result).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    });

    it('execute also refuses hide_comment and reply_dm directly, in defense of a caller that skips preflight', async () => {
      await expect(
        connector.execute(displayCtx(), {
          id: 'oa_5',
          kind: 'hide_comment',
          targetExternalId: 'comment_1',
          payload: {},
          idempotencyKey: 'k',
          requestNonce: 'n',
          requestedByUserId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
      await expect(
        connector.execute(displayCtx(), {
          id: 'oa_6',
          kind: 'reply_dm',
          payload: { text: 'hi' },
          idempotencyKey: 'k2',
          requestNonce: 'n2',
          requestedByUserId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    });

    it('ingest also refuses Business-only resources (dms, leads)', async () => {
      await expect(
        connector.fetchPage(displayCtx(), { id: 'tiktok.dms', since: null, highWaterMark: null }),
      ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
      await expect(
        connector.fetchPage(displayCtx(), { id: 'tiktok.leads', since: null, highWaterMark: null }),
      ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    });
  });

  describe('normalize purity and drift quarantine', () => {
    it('normalizes a video into a canonical post, deterministically', () => {
      const nctx = createTestNormalizeCtx(tiktokManifest, {
        accountExternalId: shared.businessAccountId,
      });
      const a = connector.normalize(KINDS.video, tiktokVideo, nctx);
      const b = connector.normalize(KINDS.video, tiktokVideo, nctx);
      expect(b).toEqual(a);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        kind: 'post',
        platform: 'TIKTOK',
        mediaType: 'video',
        externalId: tiktokVideo.id,
      });
    });

    it('normalizes a DM into a person, a conversation and an inbound message carrying replyWindowExpiresAt', () => {
      const nctx = createTestNormalizeCtx(tiktokManifest, { accountExternalId: 'biz_acct_1' });
      const a = connector.normalize(KINDS.dm, tiktokDm, nctx);
      const b = connector.normalize(KINDS.dm, tiktokDm, nctx);
      expect(b).toEqual(a);
      expect(a.map((e) => e.kind)).toEqual(['person', 'conversation', 'message']);
      const msg = a[2] as { direction: string; replyWindowExpiresAt?: Date };
      expect(msg.direction).toBe('inbound');
      expect(msg.replyWindowExpiresAt).toEqual(new Date(tiktokDm.create_time * 1000 + WINDOW_MS));
    });

    it('quarantines a drifted video shape (unknown field under a strict schema)', () => {
      const nctx = createTestNormalizeCtx(tiktokManifest);
      expect(() => connector.normalize(KINDS.video, tiktokVideoDrift, nctx)).toThrow();
    });

    it('quarantines a drifted comment shape and an unknown kind', () => {
      const nctx = createTestNormalizeCtx(tiktokManifest);
      expect(() =>
        connector.normalize(KINDS.comment, { ...tiktokComment, extra_field: 'unexpected' }, nctx),
      ).toThrow();
      expect(() => connector.normalize('tiktok_unknown', {}, nctx)).toThrow(NexusError);
    });
  });

  describe('webhooks: HMAC verification and per-kind parsing', () => {
    it('verifies a valid signature, and rejects a tampered body or the wrong secret', () => {
      expect(connector.verifyWebhook(webhookSample, shared.webhookSecret)).toBe(true);
      expect(connector.verifyWebhook(webhookSample, 'wrong-secret')).toBe(false);
      const tampered = {
        ...webhookSample,
        rawBody: `${webhookSample.rawBody.slice(0, -1)}${webhookSample.rawBody.endsWith('}') ? ' ' : '}'}`,
      };
      expect(connector.verifyWebhook(tampered, shared.webhookSecret)).toBe(false);
      expect(connector.verifyWebhook({ ...webhookSample, headers: {} }, shared.webhookSecret)).toBe(
        false,
      );
    });

    it('parses a message.receive webhook into a tiktok_dm envelope', () => {
      const [env] = connector.parseWebhook(webhookSample);
      expect(env).toMatchObject({
        kind: KINDS.dm,
        externalId: webhookDm.message_id,
        connectionHint: {
          platform: 'TIKTOK',
          connectionId: 'conn_test',
          accountExternalId: webhookDm.to_user_id,
        },
      });
    });

    it('verifies and parses a lead.submit webhook into a tiktok_lead envelope', () => {
      const lead = leadFixture(50, { lead_id: 'lead_webhook_50' });
      const req = tiktokWebhookRequest({
        path: '/api/webhooks/tiktok/conn_test',
        event: 'lead.submit',
        content: lead,
        secret: shared.webhookSecret,
      });
      expect(connector.verifyWebhook(req, shared.webhookSecret)).toBe(true);
      expect(connector.verifyWebhook(req, 'wrong-secret')).toBe(false);
      const [env] = connector.parseWebhook(req);
      expect(env).toMatchObject({
        kind: KINDS.lead,
        externalId: 'lead_webhook_50',
        connectionHint: { platform: 'TIKTOK', connectionId: 'conn_test' },
      });
    });

    it('returns [] for an unrecognized event without throwing', () => {
      const req = tiktokWebhookRequest({
        path: '/api/webhooks/tiktok/conn_test',
        // @ts-expect-error deliberately invalid event to prove parseWebhook stays safe
        event: 'ping',
        content: {},
        secret: shared.webhookSecret,
      });
      expect(connector.parseWebhook(req)).toEqual([]);
    });
  });

  describe('health', () => {
    it('reports healthy against a working double', async () => {
      const report = await connector.health(ctxFor(shared));
      expect(report.status).toBe('healthy');
      expect(report.checks.find((c) => c.id === 'reachability')?.ok).toBe(true);
      expect(report.checks.find((c) => c.id === 'token')?.ok).toBe(true);
    });

    it('reports reconnect_required without throwing when the token is rejected', async () => {
      const down = ctxFor(createTikTokDouble({ forceStatus: 401 }));
      const report = await connector.health(down);
      expect(report.status).toBe('reconnect_required');
      expect(report.checks.find((c) => c.id === 'reachability')?.ok).toBe(false);
    });
  });
});
