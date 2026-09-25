/**
 * TikTok connector (Phase 8): ONE `Connector` serving both TikTok for Business (Business
 * Account API + Marketing API messaging/leads + comment moderation) and the public Display
 * API, selected per-connection via `TikTokConfig.provider` (`'business'` default, `'display'`).
 *
 * Display never gets messaging, comment moderation or leads — `capabilities()` filters those
 * out for Display BEFORE scope degradation is even applied, and `preflight()`/`execute()`
 * refuse them with `POLICY_BLOCKED` regardless of what scopes a Display token happens to carry.
 *
 * Business Messaging replies are gated by a 48-hour window from the customer's last inbound
 * message — mirrors `@nexus/connector-meta`'s 24-hour Messenger window pattern exactly (see
 * `preflight()` below and `packages/connectors/meta/src/normalize.ts`'s `WINDOW_MS`).
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  observedFromHeaders,
  refreshAccessToken,
  revokeToken,
  verifyHmacSha256,
  type BudgetHandle,
  type CanonicalEntity,
  type CanonicalMessage,
  type CanonicalPerson,
  type Capability,
  type ConnCtx,
  type Connector,
  type DiscoveredAccount,
  type HealthReport,
  type NormalizeCtx,
  type OutboundActionInput,
  type OutboundActionKind,
  type OutboundResult,
  type Preflight,
  type RawPage,
  type ResourceRef,
  type ScopeVerification,
  type WebhookEnvelope,
  type WebhookRequest,
} from '@nexus/connector-sdk';
import { KINDS, tiktokManifest } from './manifest.ts';

export type TikTokProvider = 'business' | 'display';

export type TikTokConfig = {
  /** API origin — overridable so tests point at the double (`https://open.tiktokapis.com`). */
  baseUrl?: string;
  /**
   * `'business'` (default) exposes the full manifest capability set, subject to scope
   * verification. `'display'` is read-only public content: messaging, comment moderation and
   * leads are never available, no matter which scopes a Display token carries.
   */
  provider?: TikTokProvider;
};

/** Mirrors Meta's `WINDOW_MS` (24h) — TikTok Business Messaging's window is 48h (manifest.messagingWindowHours; see docs/connectors/tiktok.md §9 for the third-party sourcing caveat). */
export const WINDOW_MS = 48 * 3600_000;

const DISPLAY_CAPABILITIES: Capability[] = ['read:posts', 'read:profile', 'read:followers'];

// ─── raw shapes (strict: anything else is schema drift) ────────────────────

const rawVideoSchema = z
  .object({
    id: z.string(),
    create_time: z.number().int().nonnegative(),
    video_description: z.string(),
    cover_image_url: z.string().nullable(),
    share_url: z.string().nullable(),
    duration: z.number().nonnegative(),
    view_count: z.number().int().nonnegative(),
    like_count: z.number().int().nonnegative(),
    comment_count: z.number().int().nonnegative(),
    share_count: z.number().int().nonnegative(),
  })
  .strict();

const rawCommentUserSchema = z
  .object({
    open_id: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
  })
  .strict();

const rawCommentSchema = z
  .object({
    comment_id: z.string(),
    video_id: z.string(),
    text: z.string(),
    create_time: z.number().int().nonnegative(),
    user: rawCommentUserSchema,
    parent_comment_id: z.string().nullable(),
    like_count: z.number().int().nonnegative(),
  })
  .strict();

const rawDmContentSchema = z.object({ text: z.string() }).strict();

const rawDmSchema = z
  .object({
    message_id: z.string(),
    conversation_id: z.string(),
    from_user_id: z.string(),
    to_user_id: z.string(),
    content: rawDmContentSchema,
    create_time: z.number().int().nonnegative(),
    is_from_customer: z.boolean(),
  })
  .strict();

const leadFieldRawSchema = z.object({ name: z.string(), value: z.string() }).strict();

const rawLeadSchema = z
  .object({
    lead_id: z.string(),
    form_id: z.string(),
    form_name: z.string().nullable(),
    create_time: z.number().int().nonnegative(),
    ad_id: z.string().nullable(),
    campaign_id: z.string().nullable(),
    field_data: z.array(leadFieldRawSchema),
  })
  .strict();

const videoListResponseSchema = z.object({
  data: z.object({
    videos: z.array(z.unknown()),
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const commentListResponseSchema = z.object({
  data: z.object({
    comments: z.array(z.unknown()),
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const dmListResponseSchema = z.object({
  data: z.object({
    messages: z.array(z.unknown()),
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const leadListResponseSchema = z.object({
  data: z.object({
    leads: z.array(z.unknown()),
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const userInfoResponseSchema = z.object({
  data: z.object({
    user: z.object({
      open_id: z.string(),
      display_name: z.string(),
      avatar_url: z.string().nullable().optional(),
      follower_count: z.number().int().nonnegative().optional(),
    }),
  }),
});
const sendMessageResponseSchema = z.object({
  data: z.object({ message_id: z.string(), create_time: z.number().int().nonnegative() }),
});
const commentActionResponseSchema = z.object({
  data: z.object({
    comment_id: z.string(),
    create_time: z.number().int().nonnegative().optional(),
  }),
});

const webhookBodySchema = z
  .object({
    event: z.enum(['message.receive', 'lead.submit']),
    create_time: z.number().int().nonnegative(),
    content: z.unknown(),
  })
  .passthrough();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

const asId = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

async function withBudget<T>(
  budget: BudgetHandle,
  endpoint: string,
  cost: number,
  call: () => Promise<{ value: T; headers: Readonly<Record<string, string>>; status: number }>,
): Promise<{ value: T; spent: number }> {
  const r = await budget.reserve({ endpoint, cost });
  if (!r.ok) throw r.error;
  try {
    const res = await call();
    await budget.settle(r.value, {
      observed: observedFromHeaders(res.headers, Date.now()),
      httpStatus: res.status,
    });
    return { value: res.value, spent: r.value.reservedCost };
  } catch (e) {
    const status =
      e instanceof NexusError && typeof e.details.status === 'number'
        ? e.details.status
        : undefined;
    const retryAfter = e instanceof NexusError ? e.context.resumesAt : undefined;
    await budget.settle(r.value, {
      httpStatus: status,
      observed: retryAfter ? { retryAfter } : undefined,
    });
    throw e;
  }
}

function person(
  id: string,
  extra: { displayName?: string | null; avatarUrl?: string | null } = {},
  at: Date,
): CanonicalPerson {
  return {
    kind: 'person',
    platform: 'TIKTOK',
    externalId: id,
    occurredAt: at,
    sourceUrl: null,
    raw: { id, ...extra },
    handle: null,
    displayName: extra.displayName ?? null,
    avatarUrl: extra.avatarUrl ?? null,
    profileUrl: null,
  };
}

export function createTikTokConnector(config: TikTokConfig = {}): Connector<TikTokConfig> {
  const base = (config.baseUrl ?? 'https://open.tiktokapis.com').replace(/\/+$/, '');
  const url = (path: string) => `${base}${path}`;
  const providerOf = (ctx: ConnCtx<TikTokConfig>): TikTokProvider =>
    ctx.config.provider ?? 'business';
  const bearer = async (ctx: ConnCtx<TikTokConfig>) => ({
    authorization: `Bearer ${(await ctx.token()).accessToken}`,
  });

  const connector: Connector<TikTokConfig> = {
    manifest: tiktokManifest,

    // ── auth: vanilla OAuth2 (no PKCE) ──
    buildAuthUrl(ctx, opts) {
      return buildAuthorizationUrl({
        authorizeUrl: url('/v2/auth/authorize'),
        clientId: 'tiktok-client-not-configured',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
        scopeSeparator: ',',
      });
    },
    async exchangeCode(ctx, code) {
      const creds = await ctx.appCredentials();
      return exchangeAuthorizationCode(ctx.http, {
        tokenUrl: url('/v2/oauth/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: ctx.redirectUri,
        requestedScopes: tiktokManifest.scopes.map((s) => s.id),
      });
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      return refreshAccessToken(ctx.http, {
        tokenUrl: url('/v2/oauth/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token,
      });
    },
    async revoke(ctx, token) {
      const creds = await ctx.appCredentials();
      await revokeToken(ctx.http, {
        revokeUrl: url('/v2/oauth/revoke'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token: token.accessToken,
      });
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      const provider = providerOf(ctx);
      const { value } = await withBudget(ctx.budget, 'GET /v2/user/info', 1, async () => {
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/v2/user/info'),
          query: { fields: 'open_id,display_name,avatar_url,follower_count' },
          headers: await bearer(ctx),
          endpoint: 'GET /v2/user/info',
          signal: ctx.signal,
        });
        return {
          value: userInfoResponseSchema.parse(res.json()),
          headers: res.headers,
          status: res.status,
        };
      });
      const u = value.data.user;
      return [
        {
          externalId: u.open_id,
          platform: 'TIKTOK',
          name: u.display_name,
          handle: null,
          avatarUrl: u.avatar_url ?? null,
          accountType: provider === 'business' ? 'business_account' : 'display_account',
          hasOwnToken: false,
          parentExternalId: null,
          raw: u,
        },
      ];
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const missing = tiktokManifest.scopes.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<Capability>();
      for (const s of tiktokManifest.scopes)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources() {
      return tiktokManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      const offset = cursor ? Number(cursor) : 0;
      const limit = r.pageSize ?? 20;

      if (r.id === 'tiktok.videos') {
        const endpoint = 'GET /v2/video/list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/v2/video/list'),
            query: { cursor: offset, max_count: limit },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: videoListResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.data.videos.map((raw) => {
          const v = rawVideoSchema.parse(raw);
          const at = new Date(v.create_time * 1000);
          if (!hwm || at > hwm) hwm = at;
          return { kind: KINDS.video, externalId: v.id, raw, occurredAt: at };
        });
        return {
          items,
          nextCursor: value.data.has_more ? String(value.data.cursor) : null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'tiktok.comments') {
        const endpoint = 'GET /v2/business/comment/list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/v2/business/comment/list'),
            query: { cursor: offset, count: limit },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: commentListResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.data.comments.map((raw) => {
          const c = rawCommentSchema.parse(raw);
          const at = new Date(c.create_time * 1000);
          if (!hwm || at > hwm) hwm = at;
          return {
            kind: KINDS.comment,
            externalId: c.comment_id,
            parentExternalId: c.parent_comment_id ?? undefined,
            raw,
            occurredAt: at,
          };
        });
        return {
          items,
          nextCursor: value.data.has_more ? String(value.data.cursor) : null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'tiktok.dms') {
        if (providerOf(ctx) === 'display')
          throw new NexusError('POLICY_BLOCKED', {
            message: 'Business direct messages are not available on the Display provider',
          });
        const endpoint = 'GET /v2/business/dm/list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/v2/business/dm/list'),
            query: { cursor: offset, count: limit },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: dmListResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.data.messages.map((raw) => {
          const m = rawDmSchema.parse(raw);
          const at = new Date(m.create_time * 1000);
          if (!hwm || at > hwm) hwm = at;
          return { kind: KINDS.dm, externalId: m.message_id, raw, occurredAt: at };
        });
        return {
          items,
          nextCursor: value.data.has_more ? String(value.data.cursor) : null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'tiktok.leads') {
        if (providerOf(ctx) === 'display')
          throw new NexusError('POLICY_BLOCKED', {
            message: 'Leads are not available on the Display provider',
          });
        const endpoint = 'GET /v2/business/lead/list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/v2/business/lead/list'),
            query: { cursor: offset, count: limit },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: leadListResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.data.leads.map((raw) => {
          const l = rawLeadSchema.parse(raw);
          const at = new Date(l.create_time * 1000);
          if (!hwm || at > hwm) hwm = at;
          return { kind: KINDS.lead, externalId: l.lead_id, raw, occurredAt: at };
        });
        return {
          items,
          nextCursor: value.data.has_more ? String(value.data.cursor) : null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
    },
    verifyWebhook(req: WebhookRequest, secret: string): boolean {
      return verifyHmacSha256({
        rawBody: req.rawBody,
        secret,
        signature: req.headers['x-tiktok-signature'],
      });
    },
    parseWebhook(req: WebhookRequest): WebhookEnvelope[] {
      const text =
        typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return [];
      }
      const parsed = webhookBodySchema.safeParse(json);
      if (!parsed.success) return [];
      const b = parsed.data;
      const m = /\/webhooks\/tiktok\/([^/?]+)/.exec(req.path);
      const receivedAt = new Date(b.create_time * 1000);
      if (b.event === 'message.receive') {
        const c = b.content as { message_id?: unknown; to_user_id?: unknown };
        return [
          {
            kind: KINDS.dm,
            externalId: asId(c.message_id),
            raw: b.content,
            receivedAt,
            connectionHint: {
              platform: 'TIKTOK',
              connectionId: m?.[1],
              accountExternalId: typeof c.to_user_id === 'string' ? c.to_user_id : undefined,
            },
          },
        ];
      }
      if (b.event === 'lead.submit') {
        const c = b.content as { lead_id?: unknown };
        return [
          {
            kind: KINDS.lead,
            externalId: asId(c.lead_id),
            raw: b.content,
            receivedAt,
            connectionHint: { platform: 'TIKTOK', connectionId: m?.[1] },
          },
        ];
      }
      return [];
    },
    async subscribeWebhooks(ctx, resources) {
      if (!resources.some((r) => r === 'tiktok.dms' || r === 'tiktok.leads')) return;
      await withBudget(ctx.budget, 'POST /v2/business/webhook/subscribe', 1, async () => {
        const secret = await ctx.webhookSecret();
        const res = await ctx.http.request({
          method: 'POST',
          url: url('/v2/business/webhook/subscribe'),
          body: { resources, secret },
          headers: await bearer(ctx),
          endpoint: 'POST /v2/business/webhook/subscribe',
          signal: ctx.signal,
        });
        return { value: null, headers: res.headers, status: res.status };
      });
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === KINDS.video) {
        const v = rawVideoSchema.parse(raw);
        const at = new Date(v.create_time * 1000);
        return [
          {
            kind: 'post',
            platform: 'TIKTOK',
            externalId: v.id,
            occurredAt: at,
            sourceUrl: v.share_url ?? null,
            raw,
            parentExternalId: null,
            rootExternalId: null,
            authorExternalId: ctx.accountExternalId,
            postType: 'original',
            mediaType: 'video',
            body: v.video_description,
            media: v.cover_image_url ? [{ type: 'image', url: v.cover_image_url }] : [],
            publishedAt: at,
            stats: {
              likes: v.like_count,
              comments: v.comment_count,
              shares: v.share_count,
              views: v.view_count,
            },
          },
        ];
      }

      if (kind === KINDS.comment) {
        const c = rawCommentSchema.parse(raw);
        const at = new Date(c.create_time * 1000);
        const inbound = c.user.open_id !== ctx.accountExternalId;
        const msg: CanonicalMessage = {
          kind: 'message',
          platform: 'TIKTOK',
          externalId: c.comment_id,
          occurredAt: at,
          sourceUrl: null,
          raw,
          parentExternalId: c.parent_comment_id,
          rootExternalId: c.video_id,
          conversationExternalId: `video:${c.video_id}`,
          messageType: c.parent_comment_id ? 'reply' : 'comment',
          direction: inbound ? 'inbound' : 'outbound',
          authorExternalId: c.user.open_id,
          body: c.text,
          attachments: [],
          sentAt: at,
        };
        return inbound
          ? [
              person(
                c.user.open_id,
                { displayName: c.user.display_name, avatarUrl: c.user.avatar_url },
                at,
              ),
              msg,
            ]
          : [msg];
      }

      if (kind === KINDS.dm) {
        const m = rawDmSchema.parse(raw);
        const at = new Date(m.create_time * 1000);
        const inbound = m.is_from_customer;
        const customerId = inbound ? m.from_user_id : m.to_user_id;
        const msg: CanonicalMessage = {
          kind: 'message',
          platform: 'TIKTOK',
          externalId: m.message_id,
          occurredAt: at,
          sourceUrl: null,
          raw,
          parentExternalId: null,
          rootExternalId: null,
          conversationExternalId: `dm:${customerId}`,
          messageType: 'dm',
          direction: inbound ? 'inbound' : 'outbound',
          authorExternalId: m.from_user_id,
          recipientExternalIds: [m.to_user_id],
          body: m.content.text,
          attachments: [],
          sentAt: at,
          ...(inbound ? { replyWindowExpiresAt: new Date(at.getTime() + WINDOW_MS) } : {}),
        };
        const conv: CanonicalEntity = {
          kind: 'conversation',
          platform: 'TIKTOK',
          externalId: `dm:${customerId}`,
          occurredAt: at,
          sourceUrl: null,
          raw: { derivedFrom: 'message', customerId },
          conversationType: 'dm',
          participants: [
            { externalId: ctx.accountExternalId, handle: null, displayName: null, role: 'owner' },
            { externalId: customerId, handle: null, displayName: null, role: 'customer' },
          ],
          subject: null,
          status: 'open',
          lastMessageAt: at,
          replyWindowExpiresAt: inbound ? new Date(at.getTime() + WINDOW_MS) : null,
          rootExternalId: null,
        };
        return inbound ? [person(customerId, {}, at), conv, msg] : [conv, msg];
      }

      if (kind === KINDS.lead) {
        const l = rawLeadSchema.parse(raw);
        const at = new Date(l.create_time * 1000);
        const field = (n: string) => l.field_data.find((f) => f.name === n)?.value;
        const email = field('email');
        const phone = field('phone_number');
        return [
          {
            kind: 'lead',
            platform: 'TIKTOK',
            externalId: l.lead_id,
            occurredAt: at,
            sourceUrl: null,
            raw,
            source: 'lead_form',
            formExternalId: l.form_id,
            formName: l.form_name ?? undefined,
            submittedAt: at,
            fields: l.field_data.map((f) => ({ name: f.name, value: f.value })),
            fullName: field('full_name'),
            ...(email && EMAIL_RE.test(email) ? { email } : {}),
            ...(phone && E164_RE.test(phone) ? { phone } : {}),
            campaignExternalId: l.campaign_id ?? undefined,
            adExternalId: l.ad_id ?? undefined,
          },
        ];
      }

      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound ──
    async capabilities(ctx) {
      const provider = providerOf(ctx);
      const base: Capability[] =
        provider === 'display' ? DISPLAY_CAPABILITIES : [...tiktokManifest.capabilities];
      const v = await connector.verifyScopes(ctx);
      return base.filter((c) => !v.degraded.includes(c));
    },
    async preflight(ctx, action: OutboundActionInput): Promise<Preflight> {
      const provider = providerOf(ctx);
      const need: Partial<Record<OutboundActionKind, Capability>> = {
        reply_dm: 'write:reply_dm',
        reply_comment: 'write:reply_comment',
        hide_comment: 'write:hide_comment',
        delete_comment: 'write:delete_comment',
      };
      const cap = need[action.kind];
      if (!cap)
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind} is not supported on TikTok`,
          remediation: 'Use reply_dm, reply_comment, hide_comment or delete_comment.',
        };

      if (provider === 'display')
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind.replace('_', ' ')} requires TikTok for Business — this connection uses the Display provider`,
          remediation: 'Reconnect using the TikTok for Business provider to enable this action.',
        };

      const caps = await connector.capabilities(ctx);
      if (!caps.includes(cap)) {
        const scope = tiktokManifest.scopes.find((s) => s.requiredFor.includes(cap));
        return {
          ok: false,
          code: 'SCOPE_MISSING',
          reason: `${action.kind.replace('_', ' ')} needs the ${scope?.id ?? cap} scope`,
          remediation: `Re-authorize TikTok to grant ${scope?.id ?? cap}.`,
        };
      }

      const text = (action.payload as { text?: unknown } | null)?.text;
      if (
        (action.kind === 'reply_dm' || action.kind === 'reply_comment') &&
        (typeof text !== 'string' || !text.trim())
      ) {
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'The message is empty',
          remediation: 'Write something before sending.',
        };
      }

      if (action.kind === 'reply_dm') {
        const last = action.context?.lastInboundAt ?? null;
        if (!last)
          return {
            ok: false,
            code: 'POLICY_BLOCKED',
            reason:
              'This thread has no message from the customer, so the 48-hour Business Messaging window has never opened',
            remediation:
              "TikTok Business Messaging only allows replies within 48 hours of the customer's last message.",
          };
        const expires = new Date(last.getTime() + WINDOW_MS);
        if (Date.now() > expires.getTime()) {
          return {
            ok: false,
            code: 'POLICY_BLOCKED',
            reason: `The 48-hour messaging window closed at ${expires.toISOString()} — TikTok Business Messaging only allows replies within 48 hours of the customer's last message`,
            remediation:
              'Wait for the customer to write again; the window reopens with their next message.',
          };
        }
        const warnings: string[] = [];
        if (expires.getTime() - Date.now() < 3600_000)
          warnings.push(
            `The messaging window closes in ${Math.max(1, Math.round((expires.getTime() - Date.now()) / 60_000))} minutes.`,
          );
        if (typeof text === 'string' && text.length > 1000)
          warnings.push('Messages over 1,000 characters may be rejected by TikTok.');
        return { ok: true, warnings };
      }

      return { ok: true, warnings: [] };
    },
    async execute(ctx, action: OutboundActionInput): Promise<OutboundResult> {
      const rawText = (action.payload as { text?: unknown } | null)?.text;
      const text = typeof rawText === 'string' ? rawText : '';
      if (ctx.settings.dryRun)
        return {
          externalId: `dry_${action.idempotencyKey.slice(0, 12)}`,
          sentAt: new Date(),
          raw: { dryRun: true },
        };

      // Defense in depth: `execute()` is only ever called after `preflight()` passes, but a
      // Business-only action must refuse here too, not rely solely on the caller having checked.
      if (
        providerOf(ctx) === 'display' &&
        (action.kind === 'reply_dm' ||
          action.kind === 'reply_comment' ||
          action.kind === 'hide_comment' ||
          action.kind === 'delete_comment')
      ) {
        throw new NexusError('POLICY_BLOCKED', {
          message: `${action.kind} requires TikTok for Business — this connection uses the Display provider`,
        });
      }

      switch (action.kind) {
        case 'reply_dm': {
          const conversationId = action.conversationExternalId?.replace(/^dm:/, '');
          if (!conversationId)
            throw new NexusError('VALIDATION', { message: 'no conversation to reply to' });
          const endpoint = 'POST /v2/business/message/send';
          const { value } = await withBudget(ctx.budget, endpoint, 1, async () => {
            const res = await ctx.http.request({
              method: 'POST',
              url: url('/v2/business/message/send'),
              headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
              body: { conversation_id: conversationId, content: { text } },
              endpoint,
              signal: ctx.signal,
            });
            return {
              value: sendMessageResponseSchema.parse(res.json()),
              headers: res.headers,
              status: res.status,
            };
          });
          return {
            externalId: value.data.message_id,
            sentAt: new Date(value.data.create_time * 1000),
            raw: value,
          };
        }
        case 'reply_comment': {
          if (!action.targetExternalId)
            throw new NexusError('VALIDATION', { message: 'no comment to reply to' });
          const endpoint = 'POST /v2/video/comment/reply';
          const { value } = await withBudget(ctx.budget, endpoint, 1, async () => {
            const res = await ctx.http.request({
              method: 'POST',
              url: url('/v2/video/comment/reply'),
              headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
              body: { comment_id: action.targetExternalId, text },
              endpoint,
              signal: ctx.signal,
            });
            return {
              value: commentActionResponseSchema.parse(res.json()),
              headers: res.headers,
              status: res.status,
            };
          });
          return { externalId: value.data.comment_id, sentAt: new Date(), raw: value };
        }
        case 'hide_comment':
        case 'delete_comment': {
          if (!action.targetExternalId)
            throw new NexusError('VALIDATION', { message: 'no comment to manage' });
          const endpoint = 'POST /v2/video/comment/manage';
          const manageAction = action.kind === 'hide_comment' ? 'hide' : 'delete';
          const { value } = await withBudget(ctx.budget, endpoint, 1, async () => {
            const res = await ctx.http.request({
              method: 'POST',
              url: url('/v2/video/comment/manage'),
              headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
              body: { comment_id: action.targetExternalId, action: manageAction },
              endpoint,
              signal: ctx.signal,
            });
            return {
              value: commentActionResponseSchema.parse(res.json()),
              headers: res.headers,
              status: res.status,
            };
          });
          return { externalId: value.data.comment_id, sentAt: new Date(), raw: value };
        }
        default:
          throw new NexusError('POLICY_BLOCKED', {
            message: `${action.kind} is not supported on TikTok`,
          });
      }
    },

    // ── health ──
    async budget(ctx) {
      return ctx.budget.snapshot();
    },
    async health(ctx): Promise<HealthReport> {
      const checks: HealthReport['checks'] = [];
      let status: HealthReport['status'] = 'healthy';
      let lastError: HealthReport['lastError'] = null;
      let tokenExpiresAt: Date | null = null;
      try {
        const t = await ctx.token();
        tokenExpiresAt = t.expiresAt ?? null;
        checks.push({ id: 'token', ok: true });
      } catch (e) {
        checks.push({
          id: 'token',
          ok: false,
          failureClass: 'AUTH_EXPIRED',
          detail: e instanceof Error ? e.message : String(e),
        });
        status = 'reconnect_required';
      }
      try {
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/v2/user/info'),
          query: { fields: 'open_id' },
          headers: await bearer(ctx),
          endpoint: 'GET /v2/user/info',
          signal: ctx.signal,
          timeoutMs: 8_000,
        });
        userInfoResponseSchema.parse(res.json());
        checks.push({ id: 'reachability', ok: true });
      } catch (e) {
        const code = e instanceof NexusError ? e.code : 'PLATFORM_DOWN';
        checks.push({
          id: 'reachability',
          ok: false,
          failureClass: code,
          detail: e instanceof Error ? e.message : String(e),
        });
        lastError = { code, message: e instanceof Error ? e.message : String(e), at: new Date() };
        if (code === 'AUTH_EXPIRED') status = 'reconnect_required';
        else if (status === 'healthy') status = 'down';
      }
      const scopes = await connector
        .verifyScopes(ctx)
        .catch(() => ({ missing: [], degraded: [] as Capability[] }));
      checks.push({
        id: 'scopes',
        ok: scopes.missing.length === 0,
        detail: scopes.missing.length ? `missing ${scopes.missing.join(', ')}` : undefined,
      });
      if (scopes.degraded.length && status === 'healthy') status = 'degraded';
      return {
        status,
        checks,
        tokenExpiresAt,
        degradedCapabilities: scopes.degraded,
        lastError,
        checkedAt: new Date(),
      };
    },
  };
  return connector;
}
