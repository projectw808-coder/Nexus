/**
 * The Meta connector (spec §8.1): one `Connector` serving both FACEBOOK (Pages) and INSTAGRAM
 * (professional accounts linked to a Page). Every request path carries the manifest's pinned
 * version; the served version is asserted by core through `manifest.apiVersionHeader`.
 *
 * Tokens: a Page connection's `accessToken` is the Page token and its `refreshToken` is the
 * user's long-lived token (60 days). `refresh()` re-exchanges the user token and re-reads the
 * Page token, which is what Meta means by "scheduled re-exchange".
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  type AuthCtx,
  type CanonicalEntity,
  type Capability,
  type ConnCtx,
  type Connector,
  type DiscoveredAccount,
  type HealthReport,
  type HttpClient,
  type NormalizeCtx,
  type OutboundActionInput,
  type OutboundResult,
  type Platform,
  type Preflight,
  type RawItem,
  type RawPage,
  type ResourceRef,
  type ScopeVerification,
  type TokenSet,
  type WebhookEnvelope,
  type WebhookRequest,
} from '@nexus/connector-sdk';
import {
  classifyGraphError,
  graphCall,
  listSchema,
  nextCursorOf,
  rethrowGraph,
  type GraphList,
} from './graph.ts';
import { META_KINDS, metaManifest } from './manifest.ts';
import { normalizeMeta, WINDOW_MS } from './normalize.ts';
import { parseMetaWebhook, verifyMetaWebhook } from './webhooks.ts';

export type MetaConfig = {
  /** `https://graph.facebook.com` — overridable for the Graph double. */
  graphOrigin?: string;
  /** `https://www.facebook.com` — the Login dialog host. */
  loginOrigin?: string;
  /** Facebook Login for Business configuration id, when the app uses one. */
  loginConfigId?: string;
  /** The Meta app id (public), for the Login dialog URL. */
  appId?: string;
};

const tokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});
const permissionsResponse = z.object({
  data: z.array(z.object({ permission: z.string(), status: z.string() })),
});
const accountsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      access_token: z.string(),
      picture: z.object({ data: z.object({ url: z.string() }) }).optional(),
      instagram_business_account: z
        .object({
          id: z.string(),
          username: z.string().optional(),
          name: z.string().optional(),
          profile_picture_url: z.string().optional(),
        })
        .optional(),
    }),
  ),
  paging: z.unknown().optional(),
});
const idResponse = z.object({ id: z.string() });
const nodeResponse = z.object({
  id: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
});

const PAGE_FIELDS =
  'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}';
const CONVERSATION_FIELDS =
  'id,updated_time,snippet,message_count,unread_count,link,participants,messages.limit(50){id,message,created_time,from,to,attachments}';
const POST_FIELDS =
  'id,message,story,created_time,permalink_url,from,full_picture,comments.limit(100){id,message,created_time,from,parent,is_hidden,permalink_url}';
const MEDIA_FIELDS =
  'id,caption,timestamp,permalink,media_type,media_url,like_count,comments_count,username,owner,comments.limit(100){id,text,timestamp,username,from,hidden,like_count,replies{id,text,timestamp,username,from,hidden}}';
const FB_INSIGHT_METRICS =
  'page_impressions,page_impressions_unique,page_post_engagements,page_fans,page_views_total';
const IG_INSIGHT_METRICS = 'impressions,reach,follower_count,profile_views';

type Meta = Connector<MetaConfig>;

export function createMetaConnector(config: MetaConfig = {}): Meta {
  const graph = (config.graphOrigin ?? 'https://graph.facebook.com').replace(/\/+$/, '');
  const login = (config.loginOrigin ?? 'https://www.facebook.com').replace(/\/+$/, '');
  const v = metaManifest.apiVersion;
  const url = (path: string) => `${graph}/${v}${path.startsWith('/') ? path : `/${path}`}`;
  const platformName = (p: Platform) => (p === 'INSTAGRAM' ? 'Instagram' : 'Facebook');

  async function tokenCall<T>(
    http: HttpClient,
    endpoint: string,
    query: Record<string, string | undefined>,
    parse: (j: unknown) => T,
  ): Promise<T> {
    const res = await http
      .request({ method: 'GET', url: url('/oauth/access_token'), query, endpoint })
      .catch((e: unknown) => rethrowGraph(e));
    return parse(res.json());
  }

  const bearer = async (ctx: ConnCtx<MetaConfig>) => ({
    authorization: `Bearer ${(await ctx.token()).accessToken}`,
  });

  async function list(
    ctx: ConnCtx<MetaConfig>,
    endpoint: string,
    path: string,
    query: Record<string, string | number | undefined>,
    cost = 1,
  ): Promise<{ list: GraphList; served: string | undefined }> {
    const r = await graphCall(
      ctx,
      ctx.budget,
      endpoint,
      cost,
      async () =>
        ctx.http.request({
          method: 'GET',
          url: url(path),
          query,
          headers: await bearer(ctx),
          endpoint,
          signal: ctx.signal,
        }),
      (j) => listSchema.parse(j),
    );
    return { list: r.value, served: r.response.headers['facebook-api-version'] };
  }

  function sinceParams(r: ResourceRef): { since?: number; until?: undefined } {
    const since = r.highWaterMark ?? r.since;
    return since ? { since: Math.floor(since.getTime() / 1000) } : {};
  }

  const connector: Meta = {
    manifest: metaManifest,

    // ── auth ──
    buildAuthUrl(ctx, opts) {
      // The app id is public (it is in the redirect URL anyway); the secret only ever travels through appCredentials().
      return buildAuthorizationUrl({
        authorizeUrl: `${login}/${v}/dialog/oauth`,
        clientId: config.appId ?? 'app-id-not-configured',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
        scopeSeparator: ',',
        extraParams: { ...(config.loginConfigId ? { config_id: config.loginConfigId } : {}) },
      });
    },
    async exchangeCode(ctx, code) {
      const creds = await ctx.appCredentials();
      const short = await tokenCall(
        ctx.http,
        'oauth.token',
        {
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: ctx.redirectUri,
          code,
        },
        (j) => tokenResponse.parse(j),
      );
      const long = await tokenCall(
        ctx.http,
        'oauth.exchange',
        {
          grant_type: 'fb_exchange_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          fb_exchange_token: short.access_token,
        },
        (j) => tokenResponse.parse(j),
      );
      const perms = await ctx.http
        .request({
          method: 'GET',
          url: url('/me/permissions'),
          headers: { authorization: `Bearer ${long.access_token}` },
          endpoint: 'GET /me/permissions',
        })
        .catch((e: unknown) => rethrowGraph(e));
      const granted = permissionsResponse
        .parse(perms.json())
        .data.filter((p) => p.status === 'granted')
        .map((p) => p.permission);
      const expiresAt = long.expires_in
        ? new Date(Date.now() + long.expires_in * 1000)
        : new Date(Date.now() + 60 * 86_400_000);
      return {
        accessToken: long.access_token,
        refreshToken: long.access_token,
        expiresAt,
        scopes: granted,
        tokenType: 'Bearer',
        raw: { user: true, expires_in: long.expires_in },
      };
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      const userToken = token.refreshToken ?? token.accessToken;
      const long = await tokenCall(
        ctx.http,
        'oauth.exchange',
        {
          grant_type: 'fb_exchange_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          fb_exchange_token: userToken,
        },
        (j) => tokenResponse.parse(j),
      );
      const expiresAt = long.expires_in
        ? new Date(Date.now() + long.expires_in * 1000)
        : new Date(Date.now() + 60 * 86_400_000);
      const isUserToken = (token.raw as { user?: boolean } | null)?.user === true;
      if (isUserToken || !ctx.connectionId) {
        return {
          accessToken: long.access_token,
          refreshToken: long.access_token,
          expiresAt,
          scopes: token.scopes,
          tokenType: 'Bearer',
          raw: { user: true, expires_in: long.expires_in },
        };
      }
      // A Page/IG connection: re-read the Page token under the fresh user token.
      const pageId = (token.raw as { pageId?: string } | null)?.pageId;
      const accounts = await ctx.http
        .request({
          method: 'GET',
          url: url('/me/accounts'),
          query: { fields: PAGE_FIELDS },
          headers: { authorization: `Bearer ${long.access_token}` },
          endpoint: 'GET /me/accounts',
        })
        .catch((e: unknown) => rethrowGraph(e));
      const page = accountsResponse.parse(accounts.json()).data.find((p) => p.id === pageId);
      if (!page)
        throw new NexusError('AUTH_EXPIRED', {
          message: 'the Page is no longer managed by this user',
          context: { platformName: 'Facebook' },
        });
      return {
        accessToken: page.access_token,
        refreshToken: long.access_token,
        expiresAt,
        scopes: token.scopes,
        tokenType: 'Bearer',
        raw: { pageId, expires_in: long.expires_in },
      };
    },
    async revoke(ctx, token) {
      const res = await ctx.http
        .request({
          method: 'DELETE',
          url: url('/me/permissions'),
          headers: { authorization: `Bearer ${token.refreshToken ?? token.accessToken}` },
          endpoint: 'DELETE /me/permissions',
        })
        .catch((e: unknown) => rethrowGraph(e));
      void res;
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      const user = await ctx.token();
      const { value } = await graphCall(
        ctx,
        ctx.budget,
        'GET /me/accounts',
        1,
        async () =>
          ctx.http.request({
            method: 'GET',
            url: url('/me/accounts'),
            query: { fields: PAGE_FIELDS, limit: 100 },
            headers: { authorization: `Bearer ${user.accessToken}` },
            endpoint: 'GET /me/accounts',
            signal: ctx.signal,
          }),
        (j) => accountsResponse.parse(j),
      );
      const out: DiscoveredAccount[] = [];
      for (const p of value.data) {
        const pageToken: TokenSet = {
          accessToken: p.access_token,
          refreshToken: user.refreshToken ?? user.accessToken,
          expiresAt: user.expiresAt,
          scopes: user.scopes,
          tokenType: 'Bearer',
          raw: { pageId: p.id },
        };
        out.push({
          externalId: p.id,
          platform: 'FACEBOOK',
          name: p.name,
          handle: null,
          avatarUrl: p.picture?.data.url ?? null,
          accountType: 'page',
          hasOwnToken: true,
          parentExternalId: null,
          raw: { id: p.id, name: p.name, picture: p.picture },
          token: pageToken,
        });
        if (p.instagram_business_account) {
          const ig = p.instagram_business_account;
          out.push({
            externalId: ig.id,
            platform: 'INSTAGRAM',
            name: ig.name ?? ig.username ?? ig.id,
            handle: ig.username ?? null,
            avatarUrl: ig.profile_picture_url ?? null,
            accountType: 'instagram_business_account',
            hasOwnToken: true,
            parentExternalId: p.id,
            raw: ig,
            token: pageToken,
          });
        }
      }
      return out;
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const relevant = metaManifest.scopes.filter((s) =>
        ctx.platform === 'INSTAGRAM'
          ? s.id.startsWith('instagram_') ||
            s.id === 'pages_show_list' ||
            s.id === 'pages_manage_metadata'
          : !s.id.startsWith('instagram_'),
      );
      const missing = relevant.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<Capability>();
      for (const s of relevant)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources() {
      return metaManifest.resources;
    },
    async fetchPage(ctx, r, cursor): Promise<RawPage> {
      const id = ctx.accountExternalId;
      const items: RawItem[] = [];
      let page: { list: GraphList; served: string | undefined };
      const common = { after: cursor, limit: r.pageSize ?? 50 };
      const push = (
        kind: string,
        raw: unknown,
        externalId: string,
        parentExternalId?: string,
        occurredAt?: string,
      ) => {
        const at = occurredAt ? new Date(occurredAt) : undefined;
        items.push({
          kind,
          externalId,
          parentExternalId,
          raw,
          ...(at && !Number.isNaN(at.getTime()) ? { occurredAt: at } : {}),
        });
      };
      switch (r.id) {
        case 'fb.conversations':
        case 'ig.dms': {
          page = await list(
            ctx,
            `GET /:id/conversations`,
            `/${id}/conversations`,
            {
              ...common,
              fields: CONVERSATION_FIELDS,
              ...(r.id === 'ig.dms' ? { platform: 'instagram' } : {}),
            },
            2,
          );
          for (const raw of page.list.data) {
            const c = raw as { id: string; updated_time?: string; messages?: { data?: unknown[] } };
            const { messages: _m, ...conv } = c;
            push(
              r.id === 'ig.dms' ? META_KINDS.igConversation : META_KINDS.fbConversation,
              conv,
              c.id,
              undefined,
              c.updated_time,
            );
            for (const m of c.messages?.data ?? []) {
              const msg = m as { id: string; created_time?: string };
              push(
                r.id === 'ig.dms' ? META_KINDS.igMessage : META_KINDS.fbMessage,
                { ...msg, conversationId: c.id },
                msg.id,
                c.id,
                msg.created_time,
              );
            }
          }
          break;
        }
        case 'fb.comments': {
          page = await list(
            ctx,
            'GET /:id/feed',
            `/${id}/feed`,
            { ...common, fields: POST_FIELDS, ...sinceParams(r) },
            2,
          );
          for (const raw of page.list.data) {
            const p = raw as { id: string; created_time?: string; comments?: { data?: unknown[] } };
            const { comments: _c, ...post } = p;
            push(META_KINDS.fbPost, post, p.id, undefined, p.created_time);
            for (const c of p.comments?.data ?? []) {
              const cm = c as { id: string; created_time?: string };
              push(META_KINDS.fbComment, { ...cm, postId: p.id }, cm.id, p.id, cm.created_time);
            }
          }
          break;
        }
        case 'fb.mentions': {
          page = await list(ctx, 'GET /:id/tagged', `/${id}/tagged`, {
            ...common,
            fields: 'id,message,created_time,from,permalink_url',
            ...sinceParams(r),
          });
          for (const raw of page.list.data) {
            const m = raw as { id: string; created_time?: string };
            push(META_KINDS.fbMention, m, m.id, undefined, m.created_time);
          }
          break;
        }
        case 'fb.reviews': {
          page = await list(ctx, 'GET /:id/ratings', `/${id}/ratings`, {
            ...common,
            fields: 'reviewer,rating,recommendation_type,review_text,created_time,open_graph_story',
          });
          for (const raw of page.list.data) {
            const rv = raw as {
              open_graph_story?: { id: string };
              reviewer?: { id: string };
              created_time: string;
            };
            push(
              META_KINDS.fbReview,
              rv,
              rv.open_graph_story?.id ?? `${rv.reviewer?.id ?? 'anon'}:${rv.created_time}`,
              undefined,
              rv.created_time,
            );
          }
          break;
        }
        case 'fb.leads': {
          page = await list(
            ctx,
            'GET /:id/leadgen_forms',
            `/${id}/leadgen_forms`,
            {
              ...common,
              fields:
                'id,name,status,leads.limit(100){id,created_time,form_id,ad_id,adset_id,campaign_id,field_data}',
            },
            2,
          );
          for (const raw of page.list.data) {
            const f = raw as { id: string; name?: string; leads?: { data?: unknown[] } };
            for (const l of f.leads?.data ?? []) {
              const lead = l as { id: string; created_time?: string };
              push(
                META_KINDS.fbLead,
                { ...lead, form_id: f.id, formName: f.name },
                lead.id,
                f.id,
                lead.created_time,
              );
            }
          }
          break;
        }
        case 'fb.insights':
        case 'ig.insights': {
          const metrics = r.id === 'fb.insights' ? FB_INSIGHT_METRICS : IG_INSIGHT_METRICS;
          const since = r.highWaterMark ?? r.since ?? new Date(Date.now() - 30 * 86_400_000);
          page = await list(ctx, 'GET /:id/insights', `/${id}/insights`, {
            metric: metrics,
            period: 'day',
            since: Math.floor(since.getTime() / 1000),
            until: Math.floor(Date.now() / 1000),
            after: cursor,
          });
          for (const raw of page.list.data) {
            const i = raw as { name: string; period: string; values?: { end_time?: string }[] };
            push(
              r.id === 'fb.insights' ? META_KINDS.fbInsight : META_KINDS.igInsight,
              { ...i, subjectId: id },
              `${id}:${i.name}:${i.period}`,
              undefined,
              i.values?.at(-1)?.end_time,
            );
          }
          break;
        }
        case 'ig.comments': {
          page = await list(
            ctx,
            'GET /:id/media',
            `/${id}/media`,
            { ...common, fields: MEDIA_FIELDS, ...sinceParams(r) },
            2,
          );
          for (const raw of page.list.data) {
            const m = raw as { id: string; timestamp?: string; comments?: { data?: unknown[] } };
            const { comments: _c, ...media } = m;
            push(META_KINDS.igMedia, media, m.id, undefined, m.timestamp);
            for (const c of m.comments?.data ?? []) {
              const cm = c as { id: string; timestamp?: string; replies?: { data?: unknown[] } };
              const { replies, ...comment } = cm;
              push(META_KINDS.igComment, { ...comment, mediaId: m.id }, cm.id, m.id, cm.timestamp);
              for (const rp of replies?.data ?? []) {
                const reply = rp as { id: string; timestamp?: string };
                push(
                  META_KINDS.igComment,
                  { ...reply, mediaId: m.id, parentId: cm.id },
                  reply.id,
                  m.id,
                  reply.timestamp,
                );
              }
            }
          }
          break;
        }
        case 'ig.mentions': {
          page = await list(ctx, 'GET /:id/tags', `/${id}/tags`, {
            ...common,
            fields: 'id,caption,username,timestamp,permalink,media_type,owner',
          });
          for (const raw of page.list.data) {
            const m = raw as { id: string; timestamp?: string };
            push(META_KINDS.igMention, m, m.id, undefined, m.timestamp);
          }
          break;
        }
        case 'ig.followers': {
          page = await list(ctx, 'GET /:id/insights(demographics)', `/${id}/insights`, {
            metric: 'follower_demographics',
            period: 'lifetime',
            metric_type: 'total_value',
            breakdown: 'country',
          });
          for (const raw of page.list.data) {
            const d = raw as { name: string };
            push(META_KINDS.igDemographic, { ...d, subjectId: id }, `${id}:${d.name}`);
          }
          break;
        }
        default:
          throw new NexusError('VALIDATION', { message: `Meta has no resource ${r.id}` });
      }
      let hwm: Date | undefined;
      for (const i of items) if (i.occurredAt && (!hwm || i.occurredAt > hwm)) hwm = i.occurredAt;
      return {
        items,
        nextCursor: nextCursorOf(page.list),
        budgetSpent: 1,
        highWaterMark: hwm,
        servedApiVersion: page.served,
      };
    },
    verifyWebhook(req: WebhookRequest, secret: string): boolean {
      return verifyMetaWebhook(req, secret);
    },
    parseWebhook(req: WebhookRequest): WebhookEnvelope[] {
      return parseMetaWebhook(req);
    },
    async subscribeWebhooks(ctx, resources) {
      // Page-level subscription; Instagram fields are enabled at the app level in the dashboard.
      const fields = new Set<string>();
      if (resources.includes('fb.conversations') || resources.includes('ig.dms'))
        fields.add('messages').add('messaging_postbacks');
      if (resources.includes('fb.comments')) fields.add('feed');
      if (resources.includes('fb.leads')) fields.add('leadgen');
      if (fields.size === 0) return;
      const pageId =
        ctx.platform === 'INSTAGRAM'
          ? ((await ctx.token()).raw as { pageId?: string } | null)?.pageId
          : ctx.accountExternalId;
      if (!pageId) return;
      await graphCall(
        ctx,
        ctx.budget,
        'POST /:id/subscribed_apps',
        1,
        async () =>
          ctx.http.request({
            method: 'POST',
            url: url(`/${pageId}/subscribed_apps`),
            query: { subscribed_fields: [...fields].join(',') },
            headers: await bearer(ctx),
            endpoint: 'POST /:id/subscribed_apps',
            signal: ctx.signal,
          }),
        (j) => j,
      );
    },

    // ── normalize ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      return normalizeMeta(kind, raw, ctx);
    },

    // ── outbound ──
    async capabilities(ctx) {
      const v2 = await connector.verifyScopes(ctx);
      const relevant: Capability[] =
        ctx.platform === 'INSTAGRAM'
          ? [
              'read:profile',
              'read:messages',
              'read:comments',
              'read:mentions',
              'read:posts',
              'read:insights',
              'read:followers',
              'write:reply_dm',
              'write:reply_comment',
              'write:hide_comment',
              'write:delete_comment',
            ]
          : [
              'read:profile',
              'read:messages',
              'read:comments',
              'read:mentions',
              'read:posts',
              'read:insights',
              'read:leads',
              'read:reviews',
              'write:reply_dm',
              'write:reply_comment',
              'write:hide_comment',
              'write:delete_comment',
            ];
      return relevant.filter((c) => !v2.degraded.includes(c));
    },
    async preflight(ctx, action): Promise<Preflight> {
      const caps = await connector.capabilities(ctx);
      const need: Partial<Record<OutboundActionInput['kind'], Capability>> = {
        reply_dm: 'write:reply_dm',
        send_dm: 'write:reply_dm',
        reply_comment: 'write:reply_comment',
        hide_comment: 'write:hide_comment',
        unhide_comment: 'write:hide_comment',
        delete_comment: 'write:delete_comment',
      };
      const cap = need[action.kind];
      if (!cap)
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind} is not available on ${platformName(ctx.platform)}`,
          remediation: 'Use a reply, hide or delete action.',
        };
      if (!caps.includes(cap)) {
        const scope = metaManifest.scopes.find(
          (s) =>
            s.requiredFor.includes(cap) &&
            (ctx.platform === 'INSTAGRAM'
              ? s.id.startsWith('instagram_')
              : !s.id.startsWith('instagram_')),
        );
        return {
          ok: false,
          code: 'SCOPE_MISSING',
          reason: `${action.kind.replace('_', ' ')} needs the ${scope?.id ?? cap} permission`,
          remediation: `Re-authorize ${platformName(ctx.platform)} to grant ${scope?.id ?? cap}.`,
        };
      }
      const text = (action.payload as { text?: unknown } | null)?.text;
      if (
        (action.kind === 'reply_dm' ||
          action.kind === 'send_dm' ||
          action.kind === 'reply_comment') &&
        (typeof text !== 'string' || !text.trim())
      ) {
        return {
          ok: false,
          code: 'VALIDATION',
          reason: 'The message is empty',
          remediation: 'Write something before sending.',
        };
      }
      if (action.kind === 'reply_dm' || action.kind === 'send_dm') {
        const last = action.context?.lastInboundAt ?? null;
        if (!last)
          return {
            ok: false,
            code: 'POLICY_BLOCKED',
            reason:
              'This thread has no message from the customer, so the 24-hour messaging window has never opened',
            remediation: "Meta only allows replies within 24 hours of the customer's last message.",
          };
        const expires = new Date(last.getTime() + WINDOW_MS);
        if (Date.now() > expires.getTime()) {
          return {
            ok: false,
            code: 'POLICY_BLOCKED',
            reason: `The 24-hour messaging window closed at ${expires.toISOString()} — Meta only allows standard replies within 24 hours of the customer's last message`,
            remediation:
              'Wait for the customer to write again; the window reopens with their next message.',
            retryAfter: undefined,
          };
        }
        const warnings: string[] = [];
        if (expires.getTime() - Date.now() < 3600_000)
          warnings.push(
            `The messaging window closes in ${Math.max(1, Math.round((expires.getTime() - Date.now()) / 60_000))} minutes.`,
          );
        if (typeof text === 'string' && text.length > 2000)
          warnings.push('Messages over 2,000 characters are rejected by Messenger.');
        return { ok: true, warnings };
      }
      return { ok: true, warnings: [] };
    },
    async execute(ctx, action): Promise<OutboundResult> {
      const rawText = (action.payload as { text?: unknown } | null)?.text;
      const text = typeof rawText === 'string' ? rawText : '';
      if (ctx.settings.dryRun)
        return {
          externalId: `dry_${action.idempotencyKey.slice(0, 12)}`,
          sentAt: new Date(),
          raw: { dryRun: true },
        };
      const send = async (
        endpoint: string,
        req: {
          method: 'POST' | 'DELETE';
          path: string;
          body?: unknown;
          query?: Record<string, string>;
        },
      ) => {
        const r = await graphCall(
          ctx,
          ctx.budget,
          endpoint,
          1,
          async () =>
            ctx.http.request({
              method: req.method,
              url: url(req.path),
              body: req.body,
              query: req.query,
              headers: await bearer(ctx),
              endpoint,
              signal: ctx.signal,
            }),
          (j) => j,
        );
        return r.value;
      };
      switch (action.kind) {
        case 'reply_dm':
        case 'send_dm': {
          const psid = action.conversationExternalId?.replace(/^dm:/, '');
          if (!psid)
            throw new NexusError('VALIDATION', { message: 'no recipient for the message' });
          const res = z
            .object({ recipient_id: z.string().optional(), message_id: z.string() })
            .parse(
              await send('POST /:id/messages', {
                method: 'POST',
                path: `/${ctx.accountExternalId}/messages`,
                body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
              }),
            );
          return { externalId: res.message_id, sentAt: new Date(), raw: res };
        }
        case 'reply_comment': {
          if (!action.targetExternalId)
            throw new NexusError('VALIDATION', { message: 'no comment to reply to' });
          const path =
            ctx.platform === 'INSTAGRAM'
              ? `/${action.targetExternalId}/replies`
              : `/${action.targetExternalId}/comments`;
          const res = idResponse.parse(
            await send('POST /:comment/replies', { method: 'POST', path, body: { message: text } }),
          );
          return { externalId: res.id, sentAt: new Date(), raw: res };
        }
        case 'hide_comment':
        case 'unhide_comment': {
          if (!action.targetExternalId)
            throw new NexusError('VALIDATION', { message: 'no comment to hide' });
          const hide = action.kind === 'hide_comment';
          const res = await send('POST /:comment(hide)', {
            method: 'POST',
            path: `/${action.targetExternalId}`,
            query:
              ctx.platform === 'INSTAGRAM' ? { hide: String(hide) } : { is_hidden: String(hide) },
          });
          return { externalId: action.targetExternalId, sentAt: new Date(), raw: res };
        }
        case 'delete_comment': {
          if (!action.targetExternalId)
            throw new NexusError('VALIDATION', { message: 'no comment to delete' });
          const res = await send('DELETE /:comment', {
            method: 'DELETE',
            path: `/${action.targetExternalId}`,
          });
          return { externalId: action.targetExternalId, sentAt: new Date(), raw: res };
        }
        default:
          throw new NexusError('POLICY_BLOCKED', {
            message: `${action.kind} is not supported on Meta`,
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
        checks.push({
          id: 'token',
          ok: true,
          detail: t.expiresAt
            ? `user token expires ${t.expiresAt.toISOString().slice(0, 10)}`
            : undefined,
        });
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
        const res = await ctx.http
          .request({
            method: 'GET',
            url: url(`/${ctx.accountExternalId}`),
            query: { fields: 'id,name,username' },
            headers: await bearer(ctx),
            endpoint: 'GET /:id',
            signal: ctx.signal,
            timeoutMs: 8_000,
          })
          .catch((e: unknown) => rethrowGraph(e));
        nodeResponse.parse(res.json());
        checks.push({ id: 'reachability', ok: true });
        const served = res.headers['facebook-api-version'];
        checks.push({
          id: 'api_version',
          ok: !served || served === ctx.apiVersion,
          detail:
            served && served !== ctx.apiVersion
              ? `Graph served ${served}; pinned ${ctx.apiVersion} (silent fallback — upgrade the manifest)`
              : undefined,
          failureClass: served && served !== ctx.apiVersion ? 'SCHEMA_DRIFT' : undefined,
        });
        if (served && served !== ctx.apiVersion && status === 'healthy') status = 'degraded';
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

export { classifyGraphError };
export type { AuthCtx as MetaAuthCtx };
