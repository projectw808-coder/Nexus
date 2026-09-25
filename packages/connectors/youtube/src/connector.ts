/**
 * YouTube Data API v3 connector (spec §7.3, ADR-019). Standard OAuth2 authorization-code flow
 * (Google), `daily_units` quota (10,000 units/day, reset at midnight Pacific) with two endpoints
 * — `search.list` and `videos.insert` — that ALSO sit in their own 100-calls/day cap, tracked
 * independently by the SDK's rate limiter. `search.list` is deliberately not a schedulable
 * resource: video discovery walks the channel's uploads playlist with `playlistItems.list`
 * instead, and `fetchPage` refuses an explicit `yt.search` request outright unless a human is
 * waiting on it (`ctx.lane === 'interactive'`).
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  observedFromHeaders,
  refreshAccessToken,
  revokeToken,
  type BudgetHandle,
  type CanonicalEntity,
  type Capability,
  type ConnCtx,
  type Connector,
  type DiscoveredAccount,
  type HealthReport,
  type NormalizeCtx,
  type OutboundActionInput,
  type OutboundResult,
  type Preflight,
  type RawPage,
  type ResourceDescriptor,
  type ResourceRef,
  type ScopeVerification,
  type WebhookEnvelope,
  type WebhookRequest,
} from '@nexus/connector-sdk';
import { youtubeManifest, KINDS } from './manifest.ts';

export type YoutubeConfig = {
  /** API origin — `https://www.googleapis.com` in production, a double's origin in tests. */
  baseUrl: string;
};

// ─── raw shapes (strict: anything else is schema drift) ────────────────────

const thumbnailSchema = z
  .object({
    url: z.string().min(1),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

const rawVideoSchema = z
  .object({
    id: z.string().min(1),
    snippet: z
      .object({
        publishedAt: z.iso.datetime(),
        channelId: z.string().min(1),
        title: z.string(),
        description: z.string(),
        resourceId: z.object({ videoId: z.string().min(1) }).strict(),
        thumbnails: z.record(z.string(), thumbnailSchema).optional(),
      })
      .strict(),
    contentDetails: z
      .object({
        videoId: z.string().min(1),
        videoPublishedAt: z.iso.datetime().optional(),
      })
      .strict(),
  })
  .strict();

const rawCommentThreadSchema = z
  .object({
    id: z.string().min(1),
    snippet: z
      .object({
        channelId: z.string().min(1),
        videoId: z.string().min(1),
        canReply: z.boolean().optional(),
        totalReplyCount: z.number().int().nonnegative().optional(),
        isPublic: z.boolean().optional(),
        topLevelComment: z
          .object({
            id: z.string().min(1),
            snippet: z
              .object({
                authorDisplayName: z.string(),
                authorProfileImageUrl: z.string().optional(),
                authorChannelId: z
                  .object({ value: z.string().min(1) })
                  .strict()
                  .optional(),
                videoId: z.string().min(1),
                textDisplay: z.string(),
                textOriginal: z.string().optional(),
                likeCount: z.number().int().nonnegative(),
                publishedAt: z.iso.datetime(),
                updatedAt: z.iso.datetime().optional(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const listResponseSchema = z.object({
  items: z.array(z.unknown()),
  nextPageToken: z.string().optional(),
});

const channelsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      snippet: z.object({
        title: z.string(),
        customUrl: z.string().optional(),
        thumbnails: z.record(z.string(), thumbnailSchema).optional(),
      }),
    }),
  ),
});

const searchResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.object({ videoId: z.string().optional(), channelId: z.string().optional() }),
      snippet: z.object({
        title: z.string(),
        channelId: z.string(),
        publishedAt: z.iso.datetime(),
      }),
    }),
  ),
  nextPageToken: z.string().optional(),
});

const commentInsertResponseSchema = z.object({
  id: z.string().min(1),
  snippet: z.object({
    textOriginal: z.string().optional(),
    publishedAt: z.iso.datetime(),
  }),
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** YouTube convention: a channel's uploads playlist id is its channel id with `UC` → `UU`. */
function uploadsPlaylistIdOf(channelId: string): string {
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : channelId;
}

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

export function createYoutubeConnector(config: YoutubeConfig): Connector<YoutubeConfig> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = (path: string) => `${base}${path}`;
  const bearer = async (ctx: ConnCtx<YoutubeConfig>) => ({
    authorization: `Bearer ${(await ctx.token()).accessToken}`,
  });

  const connector: Connector<YoutubeConfig> = {
    manifest: youtubeManifest,

    // ── auth: standard Google OAuth2 authorization code ──
    buildAuthUrl(ctx, opts) {
      return buildAuthorizationUrl({
        authorizeUrl: url('/o/oauth2/v2/auth'),
        clientId: 'google-client-id',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
        extraParams: { access_type: 'offline', prompt: 'consent' },
      });
    },
    async exchangeCode(ctx, code, verifier) {
      const creds = await ctx.appCredentials();
      return exchangeAuthorizationCode(ctx.http, {
        tokenUrl: url('/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: ctx.redirectUri,
        verifier,
        requestedScopes: youtubeManifest.scopes.map((s) => s.id),
      });
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      return refreshAccessToken(ctx.http, {
        tokenUrl: url('/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token,
      });
    },
    async revoke(ctx, token) {
      const creds = await ctx.appCredentials();
      await revokeToken(ctx.http, {
        revokeUrl: url('/revoke'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token: token.accessToken,
      });
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      const endpoint = 'channels.list';
      const { value } = await withBudget(ctx.budget, endpoint, 1, async () => {
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/youtube/v3/channels'),
          query: { part: 'snippet,contentDetails', mine: true },
          headers: await bearer(ctx),
          endpoint,
          signal: ctx.signal,
        });
        return {
          value: channelsResponseSchema.parse(res.json()),
          headers: res.headers,
          status: res.status,
        };
      });
      return value.items.map((c) => ({
        externalId: c.id,
        platform: 'YOUTUBE',
        name: c.snippet.title,
        handle: c.snippet.customUrl ?? null,
        avatarUrl: c.snippet.thumbnails?.default?.url ?? null,
        accountType: 'channel',
        hasOwnToken: false,
        parentExternalId: null,
        raw: c,
      }));
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const missing = youtubeManifest.scopes.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<Capability>();
      for (const s of youtubeManifest.scopes)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources(): ResourceDescriptor[] {
      // Only `yt.videos` and `yt.comments` — there is deliberately no `search.list`-backed
      // resource the sync engine could ever schedule (see manifest.ts and `fetchPage` below).
      return youtubeManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      if (r.id === 'yt.videos') {
        const endpoint = 'playlistItems.list';
        const playlistId = uploadsPlaylistIdOf(ctx.accountExternalId);
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/youtube/v3/playlistItems'),
            query: {
              part: 'snippet,contentDetails',
              playlistId,
              maxResults: r.pageSize ?? 50,
              pageToken: cursor,
            },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: listResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.items.map((raw) => {
          const v = rawVideoSchema.parse(raw);
          const at = new Date(v.snippet.publishedAt);
          if (!Number.isNaN(at.getTime()) && (!hwm || at > hwm)) hwm = at;
          return {
            kind: KINDS.video,
            externalId: v.contentDetails.videoId,
            raw,
            occurredAt: Number.isNaN(at.getTime()) ? undefined : at,
          };
        });
        return {
          items,
          nextCursor: value.nextPageToken ?? null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'yt.comments') {
        const endpoint = 'commentThreads.list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/youtube/v3/commentThreads'),
            query: {
              part: 'snippet',
              channelId: ctx.accountExternalId,
              maxResults: r.pageSize ?? 50,
              pageToken: cursor,
            },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: listResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = value.items.map((raw) => {
          const c = rawCommentThreadSchema.parse(raw);
          const at = new Date(c.snippet.topLevelComment.snippet.publishedAt);
          if (!Number.isNaN(at.getTime()) && (!hwm || at > hwm)) hwm = at;
          return {
            kind: KINDS.commentThread,
            externalId: c.id,
            parentExternalId: c.snippet.videoId,
            raw,
            occurredAt: Number.isNaN(at.getTime()) ? undefined : at,
          };
        });
        return {
          items,
          nextCursor: value.nextPageToken ?? null,
          budgetSpent: spent,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'yt.search') {
        // `yt.search` is NOT a declared resource (see manifest.ts) — it can only be reached by a
        // caller that explicitly asks for it, and it must never be reachable from a scheduled
        // sync lane. Refuse BEFORE touching the budget or the platform at all.
        if (ctx.lane !== 'interactive') {
          throw new NexusError('POLICY_BLOCKED', {
            message:
              'search.list may only be used for an explicit, user-initiated search, never a scheduled sync',
            context: { reason: `refused in lane "${ctx.lane}"` },
          });
        }
        const endpoint = 'search.list';
        const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/youtube/v3/search'),
            query: {
              part: 'snippet',
              channelId: ctx.accountExternalId,
              maxResults: r.pageSize ?? 50,
              pageToken: cursor,
            },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: searchResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        const items = value.items.map((raw) => ({
          kind: KINDS.searchResult,
          externalId: raw.id.videoId ?? raw.id.channelId ?? '',
          raw,
          occurredAt: new Date(raw.snippet.publishedAt),
        }));
        return {
          items,
          nextCursor: value.nextPageToken ?? null,
          budgetSpent: spent,
        };
      }

      throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
    },
    verifyWebhook(_req: WebhookRequest, _secret: string): boolean {
      // YouTube Data API has no push webhooks (see manifest.ts `webhooks.supported: false`).
      return false;
    },
    parseWebhook(_req: WebhookRequest): WebhookEnvelope[] {
      return [];
    },
    async subscribeWebhooks(): Promise<void> {
      // No-op: nothing to subscribe to.
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === KINDS.video) {
        const v = rawVideoSchema.parse(raw);
        const publishedAt = new Date(v.snippet.publishedAt);
        const post: CanonicalEntity = {
          kind: 'post',
          platform: 'YOUTUBE',
          externalId: v.contentDetails.videoId,
          occurredAt: publishedAt,
          sourceUrl: `https://www.youtube.com/watch?v=${v.contentDetails.videoId}`,
          raw,
          parentExternalId: null,
          rootExternalId: null,
          authorExternalId: v.snippet.channelId,
          postType: 'original',
          mediaType: 'video',
          body: v.snippet.title,
          media: [],
          publishedAt,
        };
        return [post];
      }
      if (kind === KINDS.commentThread) {
        const c = rawCommentThreadSchema.parse(raw);
        const top = c.snippet.topLevelComment;
        const authorExternalId =
          top.snippet.authorChannelId?.value ?? top.snippet.authorDisplayName;
        const at = new Date(top.snippet.publishedAt);
        const person: CanonicalEntity = {
          kind: 'person',
          platform: 'YOUTUBE',
          externalId: authorExternalId,
          occurredAt: at,
          sourceUrl: null,
          raw: {
            authorChannelId: top.snippet.authorChannelId,
            authorDisplayName: top.snippet.authorDisplayName,
          },
          handle: null,
          displayName: top.snippet.authorDisplayName,
          avatarUrl: top.snippet.authorProfileImageUrl ?? null,
          profileUrl: top.snippet.authorChannelId
            ? `https://www.youtube.com/channel/${top.snippet.authorChannelId.value}`
            : null,
        };
        const message: CanonicalEntity = {
          kind: 'message',
          platform: 'YOUTUBE',
          externalId: c.id,
          occurredAt: at,
          sourceUrl: `https://www.youtube.com/watch?v=${c.snippet.videoId}&lc=${c.id}`,
          raw,
          parentExternalId: null,
          rootExternalId: c.snippet.videoId,
          conversationExternalId: `video:${c.snippet.videoId}`,
          messageType: 'comment',
          direction: authorExternalId === ctx.accountExternalId ? 'outbound' : 'inbound',
          authorExternalId,
          body: top.snippet.textDisplay,
          attachments: [],
          sentAt: at,
        };
        return authorExternalId === ctx.accountExternalId ? [message] : [person, message];
      }
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound ──
    async capabilities(ctx) {
      const v = await connector.verifyScopes(ctx);
      return youtubeManifest.capabilities.filter((c) => !v.degraded.includes(c));
    },
    async preflight(ctx, action: OutboundActionInput): Promise<Preflight> {
      if (action.kind !== 'reply_comment')
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind} is not supported by the YouTube connector`,
          remediation: 'Use reply_comment.',
        };
      const text = (action.payload as { text?: unknown })?.text;
      if (typeof text !== 'string' || !text.trim())
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'Reply text is empty',
          remediation: 'Write something before sending.',
        };
      if (!action.targetExternalId)
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'No comment to reply to',
          remediation: 'Pick the comment you are replying to.',
        };
      const caps = await connector.capabilities(ctx);
      if (!caps.includes('write:reply_comment'))
        return {
          ok: false,
          code: 'SCOPE_MISSING',
          reason: 'Comment replies need the youtube.force-ssl scope',
          remediation: 'Re-authorize the connection to grant it.',
        };
      return {
        ok: true,
        warnings:
          text.length > 10_000 ? ['Comments over 10,000 characters are rejected by YouTube.'] : [],
      };
    },
    async execute(ctx, action: OutboundActionInput): Promise<OutboundResult> {
      const rawText = (action.payload as { text?: unknown }).text;
      const text = typeof rawText === 'string' ? rawText : '';
      if (ctx.settings.dryRun)
        return {
          externalId: `dry_${action.idempotencyKey.slice(0, 12)}`,
          sentAt: new Date(),
          raw: { dryRun: true },
        };
      const endpoint = 'comments.insert';
      const { value } = await withBudget(ctx.budget, endpoint, 50, async () => {
        const res = await ctx.http.request({
          method: 'POST',
          url: url('/youtube/v3/comments'),
          query: { part: 'snippet' },
          headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
          body: {
            snippet: {
              parentId: action.targetExternalId,
              textOriginal: text,
            },
          },
          endpoint,
          signal: ctx.signal,
        });
        return {
          value: commentInsertResponseSchema.parse(res.json()),
          headers: res.headers,
          status: res.status,
        };
      });
      return {
        externalId: value.id,
        sentAt: new Date(value.snippet.publishedAt),
        raw: value,
      };
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
        // Cheap, uncapped call — `channels.list` is not one of the two capped endpoints and
        // costs only the default 1 unit, so health checks never touch the search.list budget.
        const endpoint = 'channels.list';
        await withBudget(ctx.budget, endpoint, 1, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/youtube/v3/channels'),
            query: { part: 'id', mine: true },
            headers: await bearer(ctx),
            endpoint,
            signal: ctx.signal,
            timeoutMs: 5_000,
          });
          return {
            value: channelsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
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
        status = status === 'healthy' ? 'down' : status;
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
