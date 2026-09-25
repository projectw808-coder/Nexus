/**
 * The mock connector: a complete `Connector` implementation against the mock platform. It is
 * the reference implementation every real connector is measured against (and the template the
 * `new-connector` generator scaffolds from): OAuth 2 + PKCE, reserve/settle around every call,
 * observed rate-limit headers, HMAC webhooks, pure normalisation, idempotent replies.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  connectorManifestSchema,
  exchangeAuthorizationCode,
  observedFromHeaders,
  refreshAccessToken,
  revokeToken,
  verifyHmacSha256,
  type BudgetHandle,
  type CanonicalEntity,
  type Capability,
  type ConnCtx,
  type Connector,
  type ConnectorManifest,
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

export type MockConnectorConfig = {
  /** Origin of the mock platform (`https://mock.platform.local` in-process, `http://127.0.0.1:<port>` over HTTP). */
  baseUrl: string;
};

export const MOCK_KINDS = { post: 'mock_post', comment: 'mock_comment' } as const;

export const mockManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'MOCK',
  displayName: 'Mock Platform',
  apiVersion: '2026-09',
  docsUrl: 'https://example.invalid/docs/mock',
  authKind: 'oauth2_pkce',
  scopes: [
    {
      id: 'read:posts',
      plainLanguage: 'See the posts published by your accounts',
      requiredFor: ['read:posts'],
      sensitive: false,
    },
    {
      id: 'read:comments',
      plainLanguage: 'See comments people leave on your posts',
      requiredFor: ['read:comments'],
      sensitive: false,
    },
    {
      id: 'write:reply_comment',
      plainLanguage: 'Reply to comments as your account',
      requiredFor: ['write:reply_comment'],
      sensitive: true,
    },
  ],
  resources: [
    {
      id: 'mock.posts',
      displayName: 'Posts',
      kinds: [MOCK_KINDS.post],
      defaultIntervalSeconds: 300,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'webhook'] },
    },
    {
      id: 'mock.comments',
      displayName: 'Comments',
      kinds: [MOCK_KINDS.comment],
      defaultIntervalSeconds: 60,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: {
        defaultLane: 'delta',
        allowedLanes: ['delta', 'backfill', 'webhook', 'interactive'],
      },
    },
  ],
  capabilities: ['read:posts', 'read:comments', 'write:reply_comment'],
  quota: { kind: 'fixed_window', windowSeconds: 900, limit: 1000 },
  webhooks: {
    supported: true,
    verification: 'hmac_sha256',
    resources: ['mock.posts', 'mock.comments'],
    replayable: false,
  },
  constraints: ['Pages are at most 500 items.', 'Replies need the write:reply_comment scope.'],
  tierNotes: 'No tiers — the mock serves 1,000 calls per 15 minutes per token.',
  apiVersionHeader: 'x-mock-api-version',
  outboundLimits: { comment: 500 },
  outboundAttachmentTypes: [],
} satisfies ConnectorManifest);

// ─── raw shapes (strict: anything else is schema drift) ────────────────────

const rawPostSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    authorId: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime(),
    mediaType: z.enum(['text', 'image']),
    likeCount: z.number().int(),
    commentCount: z.number().int(),
  })
  .strict();

const rawCommentSchema = z
  .object({
    id: z.string(),
    postId: z.string(),
    accountId: z.string(),
    authorId: z.string(),
    authorName: z.string(),
    authorHandle: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime(),
    replyToId: z.string().nullable(),
  })
  .strict();

const listResponseSchema = z.object({
  data: z.array(z.unknown()),
  paging: z.object({ next: z.string().nullable() }),
});
const accountsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      handle: z.string(),
      avatarUrl: z.string(),
      kind: z.string(),
    }),
  ),
});
const webhookBodySchema = z.object({
  id: z.string(),
  event: z.enum(['post.created', 'comment.created']),
  accountId: z.string(),
  data: z.unknown(),
  sentAt: z.string(),
});

const asId = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

function endpointFor(accountId: string, resource: 'posts' | 'comments'): string {
  return `GET /v1/accounts/:id/${resource}`;
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

export function createMockConnector(config: MockConnectorConfig): Connector<MockConnectorConfig> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = (path: string) => `${base}${path}`;
  const bearer = async (ctx: ConnCtx<MockConnectorConfig>) => ({
    authorization: `Bearer ${(await ctx.token()).accessToken}`,
  });

  const connector: Connector<MockConnectorConfig> = {
    manifest: mockManifest,

    // ── auth ──
    buildAuthUrl(ctx, opts) {
      if (!opts.pkce)
        throw new NexusError('VALIDATION', { message: 'the mock platform requires PKCE' });
      return buildAuthorizationUrl({
        authorizeUrl: url('/oauth/authorize'),
        clientId: 'mock-client',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
        pkce: opts.pkce,
      });
    },
    async exchangeCode(ctx, code, verifier) {
      const creds = await ctx.appCredentials();
      return exchangeAuthorizationCode(ctx.http, {
        tokenUrl: url('/oauth/token'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: ctx.redirectUri,
        verifier,
        requestedScopes: mockManifest.scopes.map((s) => s.id),
      });
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      return refreshAccessToken(ctx.http, {
        tokenUrl: url('/oauth/token'),
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
      const { value } = await withBudget(ctx.budget, 'GET /v1/accounts', 1, async () => {
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/v1/accounts'),
          headers: await bearer(ctx),
          endpoint: 'GET /v1/accounts',
          signal: ctx.signal,
        });
        return {
          value: accountsResponseSchema.parse(res.json()),
          headers: res.headers,
          status: res.status,
        };
      });
      return value.data.map((a) => ({
        externalId: a.id,
        platform: 'MOCK',
        name: a.name,
        handle: a.handle,
        avatarUrl: a.avatarUrl,
        accountType: a.kind,
        hasOwnToken: false,
        parentExternalId: null,
        raw: a,
      }));
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const missing = mockManifest.scopes.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<Capability>();
      for (const s of mockManifest.scopes)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources(): ResourceDescriptor[] {
      return mockManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      const resource =
        r.id === 'mock.posts' ? 'posts' : r.id === 'mock.comments' ? 'comments' : null;
      if (!resource) throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
      const kind = resource === 'posts' ? MOCK_KINDS.post : MOCK_KINDS.comment;
      const since = r.highWaterMark ?? r.since;
      const endpoint = endpointFor(ctx.accountExternalId, resource);
      const { value, spent } = await withBudget(ctx.budget, endpoint, 1, async () => {
        const res = await ctx.http.request({
          method: 'GET',
          url: url(`/v1/accounts/${encodeURIComponent(ctx.accountExternalId)}/${resource}`),
          query: {
            limit: r.pageSize ?? 500,
            cursor,
            since: since ? since.toISOString() : undefined,
          },
          headers: await bearer(ctx),
          endpoint,
          signal: ctx.signal,
        });
        return {
          value: {
            body: listResponseSchema.parse(res.json()),
            served: res.headers['x-mock-api-version'],
          },
          headers: res.headers,
          status: res.status,
        };
      });
      let hwm: Date | undefined;
      const items = value.body.data.map((raw) => {
        const o = raw as { id?: unknown; createdAt?: unknown; postId?: unknown };
        const at = typeof o.createdAt === 'string' ? new Date(o.createdAt) : undefined;
        if (at && !Number.isNaN(at.getTime()) && (!hwm || at > hwm)) hwm = at;
        return {
          kind,
          externalId: asId(o.id),
          parentExternalId: typeof o.postId === 'string' ? o.postId : undefined,
          raw,
          occurredAt: at && !Number.isNaN(at.getTime()) ? at : undefined,
        };
      });
      return {
        items,
        nextCursor: value.body.paging.next,
        budgetSpent: spent,
        highWaterMark: hwm,
        servedApiVersion: value.served,
      };
    },
    verifyWebhook(req: WebhookRequest, secret: string): boolean {
      return verifyHmacSha256({
        rawBody: req.rawBody,
        secret,
        signature: req.headers['x-mock-signature'],
      });
    },
    parseWebhook(req: WebhookRequest): WebhookEnvelope[] {
      const text =
        typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
      const parsed = webhookBodySchema.safeParse(JSON.parse(text));
      if (!parsed.success) return [];
      const b = parsed.data;
      const data = b.data as { id?: unknown; postId?: unknown };
      const m = /\/webhooks\/mock\/([^/?]+)/.exec(req.path);
      return [
        {
          kind: b.event === 'post.created' ? MOCK_KINDS.post : MOCK_KINDS.comment,
          externalId: asId(data.id) || b.id,
          parentExternalId: typeof data.postId === 'string' ? data.postId : undefined,
          raw: b.data,
          receivedAt: new Date(b.sentAt),
          connectionHint: {
            platform: 'MOCK',
            connectionId: m?.[1],
            accountExternalId: b.accountId,
          },
        },
      ];
    },
    async subscribeWebhooks(ctx, resources) {
      await withBudget(ctx.budget, 'POST /v1/webhooks/subscribe', 1, async () => {
        const secret = await ctx.webhookSecret();
        const res = await ctx.http.request({
          method: 'POST',
          url: url('/v1/webhooks/subscribe'),
          body: { resources, accountId: ctx.accountExternalId, secret },
          headers: await bearer(ctx),
          endpoint: 'POST /v1/webhooks/subscribe',
          signal: ctx.signal,
        });
        return { value: null, headers: res.headers, status: res.status };
      });
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === MOCK_KINDS.post) {
        const p = rawPostSchema.parse(raw);
        const post: CanonicalEntity = {
          kind: 'post',
          platform: 'MOCK',
          externalId: p.id,
          occurredAt: new Date(p.createdAt),
          sourceUrl: `${base}/p/${p.id}`,
          raw,
          parentExternalId: null,
          rootExternalId: null,
          authorExternalId: p.authorId,
          postType: 'original',
          mediaType: p.mediaType,
          body: p.body,
          media: [],
          publishedAt: new Date(p.createdAt),
          stats: { likes: p.likeCount, comments: p.commentCount },
        };
        return [post];
      }
      if (kind === MOCK_KINDS.comment) {
        const c = rawCommentSchema.parse(raw);
        const person: CanonicalEntity = {
          kind: 'person',
          platform: 'MOCK',
          externalId: c.authorId,
          occurredAt: new Date(c.createdAt),
          sourceUrl: `${base}/u/${c.authorHandle}`,
          raw: { id: c.authorId, name: c.authorName, handle: c.authorHandle },
          handle: c.authorHandle,
          displayName: c.authorName,
          avatarUrl: null,
          profileUrl: `${base}/u/${c.authorHandle}`,
        };
        const message: CanonicalEntity = {
          kind: 'message',
          platform: 'MOCK',
          externalId: c.id,
          occurredAt: new Date(c.createdAt),
          sourceUrl: `${base}/p/${c.postId}#${c.id}`,
          raw,
          parentExternalId: c.replyToId,
          rootExternalId: c.postId,
          conversationExternalId: `post:${c.postId}`,
          messageType: 'comment',
          direction: c.authorId === ctx.accountExternalId ? 'outbound' : 'inbound',
          authorExternalId: c.authorId,
          body: c.body,
          attachments: [],
          sentAt: new Date(c.createdAt),
        };
        return c.authorId === ctx.accountExternalId ? [message] : [person, message];
      }
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound ──
    async capabilities(ctx) {
      const v = await connector.verifyScopes(ctx);
      return mockManifest.capabilities.filter((c) => !v.degraded.includes(c));
    },
    async preflight(ctx, action: OutboundActionInput): Promise<Preflight> {
      if (action.kind !== 'reply_comment')
        return {
          ok: false,
          code: 'POLICY_BLOCKED',
          reason: `${action.kind} is not supported by the mock platform`,
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
          reason: 'Comment replies need the write:reply_comment scope',
          remediation: 'Re-authorize the connection to grant it.',
        };
      return {
        ok: true,
        warnings:
          text.length > 2000
            ? ['Replies over 2,000 characters are truncated by the platform.']
            : [],
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
      const endpoint = 'POST /v1/comments/:id/replies';
      const { value } = await withBudget(ctx.budget, endpoint, 1, async () => {
        const res = await ctx.http.request({
          method: 'POST',
          url: url(`/v1/comments/${encodeURIComponent(action.targetExternalId ?? '')}/replies`),
          headers: { ...(await bearer(ctx)), 'idempotency-key': action.idempotencyKey },
          body: { text },
          endpoint,
          signal: ctx.signal,
        });
        return {
          value: res.json() as { data: { id: string; createdAt: string } },
          headers: res.headers,
          status: res.status,
        };
      });
      return { externalId: value.data.id, sentAt: new Date(value.data.createdAt), raw: value };
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
          url: url('/v1/health'),
          endpoint: 'GET /v1/health',
          signal: ctx.signal,
          timeoutMs: 5_000,
        });
        const served = res.headers['x-mock-api-version'];
        checks.push({ id: 'reachability', ok: true });
        checks.push({
          id: 'api_version',
          ok: served === undefined || served === ctx.apiVersion,
          detail:
            served && served !== ctx.apiVersion
              ? `platform serves ${served}, connection pinned to ${ctx.apiVersion}`
              : undefined,
        });
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
