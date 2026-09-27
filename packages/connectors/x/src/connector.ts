/**
 * X (Twitter) API v2 connector (spec §8.2, ADR-019 Phase 8). OAuth2 + PKCE via the SDK's generic
 * helpers — X's flow is vanilla, no bespoke token exchange. Billing is per RESOURCE READ, not per
 * API call: `fetchPage` reserves an estimate (`pageSize * rate`) before the call and settles with
 * the actual cost (`items.length * rate`) once it knows how many rows came back, keyed with a
 * `resourceKey` so the SDK's 24h UTC dedup ledger makes a same-day re-poll free.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type CanonicalEntity,
  type ConnCtx,
  type Connector,
  type DiscoveredAccount,
  type HealthReport,
  type NormalizeCtx,
  type OutboundActionInput,
  type OutboundResult,
  type Preflight,
  type RawPage,
  type ResourceRef,
  type ScopeVerification,
  type WebhookEnvelope,
  type WebhookRequest,
} from '@nexus/connector-sdk';
import { xManifest, KINDS, RATE_CARD, DEFAULT_PAGE_SIZE } from './manifest.ts';

export type XConfig = {
  /** API origin — overridable so tests point at a double. */
  baseUrl: string;
  /** OAuth 2.0 client id (public — X_CLIENT_ID; the secret only ever travels through
   * ctx.appCredentials()). */
  clientId?: string;
  /** X's authorization page is served from twitter.com, not api.x.com (`baseUrl`) — a different
   * host entirely. Overridable only so a test can point at a double. */
  authorizeOrigin?: string;
};

// ─── raw shapes (strict: anything else is schema drift) ────────────────────

const rawMentionSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    author_id: z.string(),
    created_at: z.iso.datetime(),
    conversation_id: z.string().optional(),
    in_reply_to_user_id: z.string().nullable().optional(),
    /** X tombstones a deleted post rather than removing it from history — honour it, never drop it. */
    deleted: z.boolean().default(false),
  })
  .strict();

const rawDmEventSchema = z
  .object({
    id: z.string(),
    event_type: z.string().optional(),
    text: z.string(),
    sender_id: z.string(),
    dm_conversation_id: z.string(),
    created_at: z.iso.datetime(),
    deleted: z.boolean().default(false),
  })
  .strict();

const listResponseSchema = z.object({
  data: z.array(z.unknown()).default([]),
  meta: z
    .object({ next_token: z.string().optional(), result_count: z.number().optional() })
    .optional(),
});

const usersMeResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    profile_image_url: z.string().optional(),
  }),
});

type ResourceId = 'x.mentions' | 'x.dms';

function endpointFor(id: ResourceId): string {
  return id === 'x.mentions' ? 'GET /2/users/:id/mentions' : 'GET /2/dm_events';
}

export function createXConnector(config: XConfig): Connector<XConfig> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = (path: string) => `${base}${path}`;
  const authorizeBase = (config.authorizeOrigin ?? 'https://twitter.com').replace(/\/+$/, '');
  const bearer = async (ctx: ConnCtx<XConfig>) => ({
    authorization: `Bearer ${(await ctx.token()).accessToken}`,
  });

  async function fetchResourcePage(
    ctx: ConnCtx<XConfig>,
    id: ResourceId,
    cursor: string | undefined,
    since: Date | null,
    pageSize: number,
  ): Promise<RawPage> {
    const rate = RATE_CARD[id];
    const endpoint = endpointFor(id);
    // Billed per item read, not per call: reserve a pessimistic estimate (a full page) up front —
    // this is what makes reserve() enforce the spend cap BEFORE we hit the platform — then settle
    // with the true cost once we know how many rows actually came back.
    const estCost = pageSize * rate;
    const resourceKey = `${ctx.accountExternalId}:${id}`;
    const r = await ctx.budget.reserve({ endpoint, cost: estCost, resourceKey });
    if (!r.ok) throw r.error;
    const reservation = r.value;
    // The 24h dedup ledger (spec §8.2) zeroes `reservedCost` at reserve() time when this exact
    // resourceKey was already charged today — settling with a nonzero actualCost would silently
    // undo that dedup, so detect it here rather than recomputing cost from `items.length` blindly.
    const wasDeduped = estCost > 0 && reservation.reservedCost === 0;
    try {
      const requestUrl =
        id === 'x.mentions'
          ? url(`/2/users/${encodeURIComponent(ctx.accountExternalId)}/mentions`)
          : url('/2/dm_events');
      const res = await ctx.http.request({
        method: 'GET',
        url: requestUrl,
        query: {
          max_results: pageSize,
          pagination_token: cursor,
          start_time: since ? since.toISOString() : undefined,
        },
        headers: await bearer(ctx),
        endpoint,
        signal: ctx.signal,
      });
      const body = listResponseSchema.parse(res.json());
      let hwm: Date | undefined;
      const items = body.data.map((raw) => {
        const parsed =
          id === 'x.mentions' ? rawMentionSchema.parse(raw) : rawDmEventSchema.parse(raw);
        const at = new Date(parsed.created_at);
        if (!Number.isNaN(at.getTime()) && (!hwm || at > hwm)) hwm = at;
        return {
          kind: id === 'x.mentions' ? KINDS.mention : KINDS.dm,
          externalId: parsed.id,
          raw,
          occurredAt: Number.isNaN(at.getTime()) ? undefined : at,
        };
      });
      const actualCost = wasDeduped ? 0 : items.length * rate;
      // Deliberately NOT forwarding `observedFromHeaders()` here: X's `x-rate-limit-*` headers
      // report the classic per-endpoint CALL quota (e.g. 450 requests/15 min), a separate concept
      // from the dollar-denominated metered_credits budget this connector tracks. The SDK's
      // generic `applyObservedUsage` treats any observed `limit`/`remaining` as authoritative for
      // whichever window it is settling — feeding call-count headers into a credits settle would
      // silently overwrite the real spend with a call count. A 429 on the call-based limit is
      // still raised correctly as RATE_LIMITED by the HTTP client itself, independent of this.
      await ctx.budget.settle(reservation, {
        actualCost,
        httpStatus: res.status,
      });
      return {
        items,
        nextCursor: body.meta?.next_token ?? null,
        budgetSpent: actualCost,
        highWaterMark: hwm,
      };
    } catch (e) {
      const status =
        e instanceof NexusError && typeof e.details.status === 'number'
          ? e.details.status
          : undefined;
      await ctx.budget.settle(reservation, { httpStatus: status });
      throw e;
    }
  }

  const connector: Connector<XConfig> = {
    manifest: xManifest,

    // ── auth: OAuth2 + PKCE, the SDK's generic helpers — X's flow is vanilla ──
    buildAuthUrl(ctx, opts) {
      if (!opts.pkce)
        throw new NexusError('VALIDATION', { message: 'X requires PKCE (authKind: oauth2_pkce)' });
      return buildAuthorizationUrl({
        // twitter.com, not `url()` — X's OAuth 2.0 authorize page is not served from api.x.com,
        // and the old OAuth 1.0a `/oauth/authorize` path doesn't exist under OAuth 2.0 either.
        authorizeUrl: `${authorizeBase}/i/oauth2/authorize`,
        clientId: config.clientId ?? 'x-client-id-not-configured',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
        pkce: opts.pkce,
        scopeSeparator: ' ',
      });
    },
    async exchangeCode(ctx, code, verifier) {
      const creds = await ctx.appCredentials();
      return exchangeAuthorizationCode(ctx.http, {
        tokenUrl: url('/2/oauth2/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: ctx.redirectUri,
        verifier,
        requestedScopes: xManifest.scopes.map((s) => s.id),
      });
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      return refreshAccessToken(ctx.http, {
        tokenUrl: url('/2/oauth2/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token,
      });
    },
    async revoke(ctx, token) {
      const creds = await ctx.appCredentials();
      await revokeToken(ctx.http, {
        revokeUrl: url('/oauth/revoke'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token: token.accessToken,
      });
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      // X has no Meta-style Page fan-out: the OAuth grant is for exactly one authenticated user.
      const res = await ctx.http.request({
        method: 'GET',
        url: url('/2/users/me'),
        headers: await bearer(ctx),
        endpoint: 'GET /2/users/me',
        signal: ctx.signal,
      });
      const { data: u } = usersMeResponseSchema.parse(res.json());
      return [
        {
          externalId: u.id,
          platform: 'X',
          name: u.name,
          handle: u.username,
          avatarUrl: u.profile_image_url ?? null,
          accountType: 'user',
          hasOwnToken: false,
          parentExternalId: null,
          raw: u,
        },
      ];
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const missing = xManifest.scopes.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<(typeof xManifest.capabilities)[number]>();
      for (const s of xManifest.scopes)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources() {
      return xManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      if (r.id !== 'x.mentions' && r.id !== 'x.dms')
        throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
      const pageSize = r.pageSize ?? DEFAULT_PAGE_SIZE;
      const since = r.highWaterMark ?? r.since;
      return fetchResourcePage(ctx, r.id, cursor, since, pageSize);
    },
    verifyWebhook(_req: WebhookRequest, _secret: string): boolean {
      // webhooks.supported is false (spec §8.2 / ADR-019): classic Account Activity webhooks are
      // deprecated and the filtered-stream alternative is out of scope for this connector today.
      return false;
    },
    parseWebhook(_req: WebhookRequest): WebhookEnvelope[] {
      return [];
    },
    async subscribeWebhooks(): Promise<void> {
      // No-op: this connector has no webhook support to subscribe (see verifyWebhook).
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === KINDS.mention) {
        const m = rawMentionSchema.parse(raw);
        const isOwn = m.author_id === ctx.accountExternalId;
        const person: CanonicalEntity = {
          kind: 'person',
          platform: 'X',
          externalId: m.author_id,
          occurredAt: new Date(m.created_at),
          sourceUrl: `https://x.com/i/user/${m.author_id}`,
          raw: { id: m.author_id },
          handle: null,
          displayName: null,
          avatarUrl: null,
          profileUrl: `https://x.com/i/user/${m.author_id}`,
        };
        const message: CanonicalEntity = {
          kind: 'message',
          platform: 'X',
          externalId: m.id,
          occurredAt: new Date(m.created_at),
          sourceUrl: `https://x.com/i/web/status/${m.id}`,
          raw,
          parentExternalId: m.in_reply_to_user_id ?? null,
          rootExternalId: m.conversation_id ?? null,
          conversationExternalId: m.conversation_id ?? `mention:${m.id}`,
          messageType: 'mention',
          direction: isOwn ? 'outbound' : 'inbound',
          authorExternalId: m.author_id,
          body: m.text,
          attachments: [],
          sentAt: new Date(m.created_at),
          isDeleted: m.deleted ? true : undefined,
        };
        return isOwn ? [message] : [person, message];
      }
      if (kind === KINDS.dm) {
        const d = rawDmEventSchema.parse(raw);
        const isOwn = d.sender_id === ctx.accountExternalId;
        const person: CanonicalEntity = {
          kind: 'person',
          platform: 'X',
          externalId: d.sender_id,
          occurredAt: new Date(d.created_at),
          sourceUrl: `https://x.com/i/user/${d.sender_id}`,
          raw: { id: d.sender_id },
          handle: null,
          displayName: null,
          avatarUrl: null,
          profileUrl: `https://x.com/i/user/${d.sender_id}`,
        };
        const message: CanonicalEntity = {
          kind: 'message',
          platform: 'X',
          externalId: d.id,
          occurredAt: new Date(d.created_at),
          sourceUrl: null,
          raw,
          parentExternalId: null,
          rootExternalId: d.dm_conversation_id,
          conversationExternalId: d.dm_conversation_id,
          messageType: 'dm',
          direction: isOwn ? 'outbound' : 'inbound',
          authorExternalId: d.sender_id,
          body: d.text,
          attachments: [],
          sentAt: new Date(d.created_at),
          isDeleted: d.deleted ? true : undefined,
        };
        return isOwn ? [message] : [person, message];
      }
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound ──
    async capabilities(ctx) {
      const v = await connector.verifyScopes(ctx);
      return xManifest.capabilities.filter((c) => !v.degraded.includes(c));
    },
    async preflight(ctx, action: OutboundActionInput): Promise<Preflight> {
      if (action.kind !== 'reply_dm')
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind} is not supported by the X connector`,
          remediation: 'Use reply_dm.',
        };
      const text = (action.payload as { text?: unknown } | undefined)?.text;
      if (typeof text !== 'string' || !text.trim())
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'Reply text is empty',
          remediation: 'Write something before sending.',
        };
      if (!action.conversationExternalId && !action.targetExternalId)
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'No DM conversation or recipient to reply to',
          remediation: 'Pick the conversation you are replying to.',
        };
      const caps = await connector.capabilities(ctx);
      if (!caps.includes('write:reply_dm'))
        return {
          ok: false,
          code: 'SCOPE_MISSING',
          reason: 'DM replies need the dm.read and dm.write scopes',
          remediation: 'Re-authorize the connection to grant them.',
        };
      const hasUrl = /https?:\/\//i.test(text);
      return {
        ok: true,
        warnings: hasUrl
          ? ['Replies containing a URL cost 13x more on X ($0.20 instead of $0.015).']
          : [],
      };
    },
    async execute(ctx, action: OutboundActionInput): Promise<OutboundResult> {
      if (action.kind !== 'reply_dm')
        throw new NexusError('POLICY_BLOCKED', {
          message: `${action.kind} is not supported by the X connector`,
        });
      const rawText = (action.payload as { text?: unknown } | undefined)?.text;
      const text = typeof rawText === 'string' ? rawText : '';
      if (!text.trim()) throw new NexusError('VALIDATION', { message: 'reply text is empty' });
      if (ctx.settings.dryRun)
        return {
          externalId: `dry_${action.idempotencyKey.slice(0, 12)}`,
          sentAt: new Date(),
          raw: { dryRun: true },
        };
      const hasUrl = /https?:\/\//i.test(text);
      const rateKey = hasUrl ? 'reply_dm_url' : 'reply_dm';
      const cost = RATE_CARD[rateKey];
      const endpoint = 'POST /2/dm_conversations/:id/messages';
      const r = await ctx.budget.reserve({ endpoint, cost });
      if (!r.ok) throw r.error;
      try {
        const conversationId = action.conversationExternalId;
        const requestUrl = conversationId
          ? url(`/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`)
          : url(
              `/2/dm_conversations/with/${encodeURIComponent(action.targetExternalId ?? '')}/messages`,
            );
        const res = await ctx.http.request({
          method: 'POST',
          url: requestUrl,
          headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
          body: { text },
          endpoint,
          signal: ctx.signal,
        });
        const value = res.json() as { data: { dm_event_id: string; sent_at?: string } };
        // Same reasoning as fetchResourcePage: don't let X's call-based rate-limit headers
        // overwrite the dollar-denominated metered_credits spend.
        await ctx.budget.settle(r.value, { httpStatus: res.status });
        return {
          externalId: value.data.dm_event_id,
          sentAt: value.data.sent_at ? new Date(value.data.sent_at) : new Date(),
          raw: value,
        };
      } catch (e) {
        const status =
          e instanceof NexusError && typeof e.details.status === 'number'
            ? e.details.status
            : undefined;
        await ctx.budget.settle(r.value, { httpStatus: status });
        throw e;
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
        await ctx.http.request({
          method: 'GET',
          url: url('/2/users/me'),
          headers: await bearer(ctx),
          endpoint: 'GET /2/users/me',
          signal: ctx.signal,
          timeoutMs: 5_000,
        });
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
        status =
          code === 'AUTH_EXPIRED' ? 'reconnect_required' : status === 'healthy' ? 'down' : status;
      }
      const scopes = await connector
        .verifyScopes(ctx)
        .catch(() => ({ missing: [] as string[], degraded: [] as ScopeVerification['degraded'] }));
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
