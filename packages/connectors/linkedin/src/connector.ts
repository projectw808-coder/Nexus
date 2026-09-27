/**
 * LinkedIn connector (spec §8, Phase 8). Member identity is a vanilla 3-legged OAuth2 flow
 * (OIDC `openid`/`profile`/`email`); organization content (Community Management API) and Lead
 * Sync additionally need the app approved for LinkedIn's Marketing Developer Platform — "not
 * yet approved" is treated as a first-class connection state, not an error (see `health()` and
 * `verifyScopes()` below). Read-only outbound: `execute`/`preflight` always refuse, and no DM
 * capability is modelled anywhere — member-to-member messaging is not available on this API.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  observedFromHeaders,
  refreshAccessToken,
  revokeToken,
  verifySharedSecret,
  type BudgetHandle,
  type CanonicalEntity,
  type Capability,
  type ConnCtx,
  type Connector,
  type DiscoveredAccount,
  type HealthReport,
  type NormalizeCtx,
  type Preflight,
  type RawPage,
  type ResourceRef,
  type ScopeVerification,
  type WebhookEnvelope,
  type WebhookRequest,
} from '@nexus/connector-sdk';
import { linkedinManifest, KINDS } from './manifest.ts';

export type LinkedinConfig = {
  /** API origin — overridable so tests point at a double (`https://api.linkedin.com` in prod). */
  baseUrl: string;
  /** OAuth 2.0 client id (public — LINKEDIN_CLIENT_ID; the secret only ever travels through
   * ctx.appCredentials()). */
  clientId?: string;
  /** LinkedIn's OAuth authorize AND token endpoints are both on www.linkedin.com, not
   * api.linkedin.com (`baseUrl`, which is only the data API's origin). Overridable only so a
   * test can point at a double. */
  oauthOrigin?: string;
};

/** Scopes that gate organization content and Lead Sync — see manifest.ts for why. */
const APPROVAL_SCOPES = [
  'r_organization_social',
  'rw_organization_admin',
  'r_marketing_leadgen_automation',
] as const;

// ─── raw shapes (strict: anything else is schema drift) ────────────────────

const rawPostSchema = z
  .object({
    id: z.string(),
    author: z.string(),
    commentary: z.string(),
    createdAt: z.number().int(),
    lastModifiedAt: z.number().int().optional(),
    lifecycleState: z.enum(['PUBLISHED', 'DRAFT']),
    visibility: z.enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN', 'CONTAINER']),
    contentType: z
      .enum(['NONE', 'IMAGE', 'VIDEO', 'ARTICLE', 'CAROUSEL', 'DOCUMENT'])
      .default('NONE'),
    totalSocialActivityCounts: z
      .object({
        numLikes: z.number().int().nonnegative().optional(),
        numComments: z.number().int().nonnegative().optional(),
        numShares: z.number().int().nonnegative().optional(),
        numViews: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .strict();

const rawCommentSchema = z
  .object({
    id: z.string(),
    object: z.string(),
    actor: z.string(),
    message: z.object({ text: z.string() }),
    created: z.number().int(),
    lastModified: z.number().int().optional(),
    parentComment: z.string().nullable().optional(),
  })
  .strict();

const rawLeadAnswerSchema = z
  .object({
    questionId: z.string(),
    question: z.string(),
    answer: z.string().nullable(),
  })
  .strict();

const rawLeadSchema = z
  .object({
    id: z.string(),
    formId: z.string(),
    formName: z.string().optional(),
    owner: z.string(),
    campaign: z.string().optional(),
    submittedAt: z.number().int(),
    testLead: z.boolean().optional(),
    answers: z.array(rawLeadAnswerSchema),
    consentToMarketing: z.boolean().optional(),
  })
  .strict();

const pagingSchema = z.object({
  start: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const postsResponseSchema = z.object({ elements: z.array(z.unknown()), paging: pagingSchema });
const commentsResponseSchema = z.object({ elements: z.array(z.unknown()), paging: pagingSchema });
const leadsResponseSchema = z.object({ elements: z.array(z.unknown()), paging: pagingSchema });

const organizationAclsResponseSchema = z.object({
  elements: z.array(
    z.object({
      organizationalTarget: z.string(),
      role: z.string(),
      state: z.string(),
      'organizationalTarget~': z
        .object({
          localizedName: z.string(),
          vanityName: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const userinfoResponseSchema = z.object({
  sub: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});

const webhookBodySchema = z
  .object({
    leadId: z.string(),
    formId: z.string().optional(),
    owner: z.string().optional(),
  })
  .passthrough();

// ─── helpers ────────────────────────────────────────────────────────────────

async function withBudget<T>(
  budget: BudgetHandle,
  endpoint: string,
  call: () => Promise<{ value: T; headers: Readonly<Record<string, string>>; status: number }>,
): Promise<T> {
  const r = await budget.reserve({ endpoint, cost: 1 });
  if (!r.ok) throw r.error;
  try {
    const res = await call();
    await budget.settle(r.value, {
      observed: observedFromHeaders(res.headers, Date.now()),
      httpStatus: res.status,
    });
    return res.value;
  } catch (e) {
    const status =
      e instanceof NexusError && typeof e.details.status === 'number'
        ? e.details.status
        : undefined;
    await budget.settle(r.value, { httpStatus: status });
    throw e;
  }
}

/** Every call this connector makes carries the pinned monthly version as a HEADER, never a URL segment. */
function versionedHeaders(ctx: ConnCtx<LinkedinConfig>, bearer: string): Record<string, string> {
  return { authorization: bearer, 'LinkedIn-Version': ctx.apiVersion };
}

async function bearerOf(ctx: ConnCtx<LinkedinConfig>): Promise<string> {
  return `Bearer ${(await ctx.token()).accessToken}`;
}

function mapContentTypeToMediaType(
  contentType: z.infer<typeof rawPostSchema>['contentType'],
): 'text' | 'image' | 'video' | 'carousel' | 'link' | 'other' {
  switch (contentType) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'CAROUSEL':
      return 'carousel';
    case 'ARTICLE':
      return 'link';
    case 'DOCUMENT':
      return 'other';
    case 'NONE':
    default:
      return 'text';
  }
}

/** Find an answer by (case-insensitive) question label — LinkedIn Lead Sync has no stable field-name schema across forms. */
function findAnswer(
  answers: z.infer<typeof rawLeadAnswerSchema>[],
  ...labels: string[]
): string | undefined {
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  const found = answers.find((a) => wanted.has(a.question.toLowerCase()));
  return found?.answer ?? undefined;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

export function createLinkedinConnector(config: LinkedinConfig): Connector<LinkedinConfig> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = (path: string) => `${base}${path}`;
  const oauthBase = (config.oauthOrigin ?? 'https://www.linkedin.com').replace(/\/+$/, '');
  const oauthUrl = (path: string) => `${oauthBase}${path}`;

  const connector: Connector<LinkedinConfig> = {
    manifest: linkedinManifest,

    // ── auth: vanilla 3-legged OAuth2 (no PKCE requirement documented for LinkedIn) ──
    buildAuthUrl(ctx, opts) {
      return buildAuthorizationUrl({
        // www.linkedin.com, not `url()` — LinkedIn's OAuth endpoints live there, not on
        // api.linkedin.com (the data API origin `baseUrl` points at).
        authorizeUrl: oauthUrl('/oauth/v2/authorization'),
        clientId: config.clientId ?? 'linkedin-client-id-not-configured',
        redirectUri: ctx.redirectUri,
        scopes: opts.scopes,
        state: opts.state,
      });
    },
    async exchangeCode(ctx, code) {
      const creds = await ctx.appCredentials();
      return exchangeAuthorizationCode(ctx.http, {
        tokenUrl: oauthUrl('/oauth/v2/accessToken'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: ctx.redirectUri,
        requestedScopes: linkedinManifest.scopes.map((s) => s.id),
      });
    },
    async refresh(ctx, token) {
      const creds = await ctx.appCredentials();
      return refreshAccessToken(ctx.http, {
        tokenUrl: oauthUrl('/oauth/v2/accessToken'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token,
      });
    },
    async revoke(ctx, token) {
      const creds = await ctx.appCredentials();
      await revokeToken(ctx.http, {
        revokeUrl: oauthUrl('/oauth/v2/revoke'),
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        token: token.accessToken,
      });
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      const bearer = await bearerOf(ctx);
      const endpoint = 'GET /rest/organizationAcls';
      const value = await withBudget(ctx.budget, endpoint, async () => {
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/rest/organizationAcls'),
          query: { q: 'roleAssignee' },
          headers: versionedHeaders(ctx, bearer),
          endpoint,
          signal: ctx.signal,
        });
        return {
          value: organizationAclsResponseSchema.parse(res.json()),
          headers: res.headers,
          status: res.status,
        };
      });
      return value.elements
        .filter((el) => el.role === 'ADMINISTRATOR' && el.state === 'APPROVED')
        .map((el) => ({
          externalId: el.organizationalTarget,
          platform: 'LINKEDIN',
          name: el['organizationalTarget~']?.localizedName ?? el.organizationalTarget,
          handle: el['organizationalTarget~']?.vanityName ?? null,
          avatarUrl: null,
          accountType: 'organization',
          hasOwnToken: false,
          parentExternalId: null,
          raw: el,
        }));
    },
    async verifyScopes(ctx): Promise<ScopeVerification> {
      const granted = new Set((await ctx.token()).scopes);
      const missing = linkedinManifest.scopes.filter((s) => !granted.has(s.id)).map((s) => s.id);
      const degraded = new Set<Capability>();
      for (const s of linkedinManifest.scopes)
        if (missing.includes(s.id)) s.requiredFor.forEach((c) => degraded.add(c));
      return { missing, degraded: [...degraded] };
    },

    // ── ingest ──
    listResources() {
      return linkedinManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      const bearer = await bearerOf(ctx);
      const start = cursor ? Number(cursor) : 0;
      const count = r.pageSize ?? 10;

      if (r.id === 'li.posts') {
        const endpoint = 'GET /rest/posts';
        const body = await withBudget(ctx.budget, endpoint, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/rest/posts'),
            query: { author: ctx.accountExternalId, q: 'author', start, count },
            headers: versionedHeaders(ctx, bearer),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: postsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = body.elements.map((raw) => {
          const p = rawPostSchema.parse(raw);
          const at = new Date(p.createdAt);
          if (!hwm || at > hwm) hwm = at;
          return { kind: KINDS.post, externalId: p.id, raw, occurredAt: at };
        });
        const nextCursor =
          start + body.elements.length < body.paging.total ? String(start + count) : null;
        return { items, nextCursor, budgetSpent: 1, highWaterMark: hwm };
      }

      if (r.id === 'li.comments') {
        const endpoint = 'GET /rest/organizationalEntityComments';
        const body = await withBudget(ctx.budget, endpoint, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/rest/organizationalEntityComments'),
            query: { organizationalEntity: ctx.accountExternalId, start, count },
            headers: versionedHeaders(ctx, bearer),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: commentsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = body.elements.map((raw) => {
          const c = rawCommentSchema.parse(raw);
          const at = new Date(c.created);
          if (!hwm || at > hwm) hwm = at;
          return {
            kind: KINDS.comment,
            externalId: c.id,
            parentExternalId: c.parentComment ?? undefined,
            raw,
            occurredAt: at,
          };
        });
        const nextCursor =
          start + body.elements.length < body.paging.total ? String(start + count) : null;
        return { items, nextCursor, budgetSpent: 1, highWaterMark: hwm };
      }

      if (r.id === 'li.leads') {
        const endpoint = 'GET /rest/leadFormResponses';
        const body = await withBudget(ctx.budget, endpoint, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: url('/rest/leadFormResponses'),
            query: { owner: ctx.accountExternalId, start, count },
            headers: versionedHeaders(ctx, bearer),
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: leadsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = body.elements.map((raw) => {
          const l = rawLeadSchema.parse(raw);
          const at = new Date(l.submittedAt);
          if (!hwm || at > hwm) hwm = at;
          return { kind: KINDS.lead, externalId: l.id, raw, occurredAt: at };
        });
        const nextCursor =
          start + body.elements.length < body.paging.total ? String(start + count) : null;
        return { items, nextCursor, budgetSpent: 1, highWaterMark: hwm };
      }

      throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
    },

    // Lead Sync's exact push-signing scheme is not confidently documented publicly (see
    // docs §7): treated here as a shared verification token the platform echoes back, not an
    // HMAC over the body — that claim would be unverified. Consequently this only proves the
    // sender knows the token, not body integrity (same call the Keitaro connector made for its
    // own shared_secret webhook — see its connector.test.ts comment).
    verifyWebhook(req: WebhookRequest, secret: string): boolean {
      return verifySharedSecret(req.headers['x-li-verification-token'], secret);
    },
    parseWebhook(req: WebhookRequest): WebhookEnvelope[] {
      const text =
        typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return [];
      }
      const body = webhookBodySchema.safeParse(parsed);
      if (!body.success) return [];
      const m = /\/webhooks\/linkedin\/([^/?]+)/.exec(req.path);
      return [
        {
          kind: KINDS.lead,
          externalId: body.data.leadId,
          raw: body.data,
          receivedAt: new Date(),
          connectionHint: {
            platform: 'LINKEDIN',
            connectionId: m?.[1],
            accountExternalId: body.data.owner,
          },
        },
      ];
    },
    async subscribeWebhooks(ctx, resources) {
      if (!resources.includes('li.leads')) return;
      const bearer = await bearerOf(ctx);
      const endpoint = 'POST /rest/leadNotifications';
      await withBudget(ctx.budget, endpoint, async () => {
        const secret = await ctx.webhookSecret();
        const res = await ctx.http.request({
          method: 'POST',
          url: url('/rest/leadNotifications'),
          body: { owner: ctx.accountExternalId, verificationToken: secret },
          headers: versionedHeaders(ctx, bearer),
          endpoint,
          signal: ctx.signal,
        });
        return { value: null, headers: res.headers, status: res.status };
      });
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === KINDS.post) {
        const p = rawPostSchema.parse(raw);
        const post: CanonicalEntity = {
          kind: 'post',
          platform: 'LINKEDIN',
          externalId: p.id,
          occurredAt: new Date(p.createdAt),
          sourceUrl: `https://www.linkedin.com/feed/update/${p.id}`,
          raw,
          parentExternalId: null,
          rootExternalId: null,
          authorExternalId: p.author,
          postType: 'original',
          mediaType: mapContentTypeToMediaType(p.contentType),
          body: p.commentary,
          media: [],
          publishedAt: new Date(p.createdAt),
          editedAt: p.lastModifiedAt ? new Date(p.lastModifiedAt) : undefined,
          stats: p.totalSocialActivityCounts
            ? {
                likes: p.totalSocialActivityCounts.numLikes,
                comments: p.totalSocialActivityCounts.numComments,
                shares: p.totalSocialActivityCounts.numShares,
                views: p.totalSocialActivityCounts.numViews,
              }
            : undefined,
        };
        return [post];
      }
      if (kind === KINDS.comment) {
        // A LinkedIn comment normalizes to a single CanonicalMessage (messageType: 'comment').
        // Reactions are not modelled as a separate CanonicalEngagement this phase: the
        // Community Management API reports them only as the aggregate counts already captured
        // in the parent post's `stats.likes` (from `totalSocialActivityCounts`), not as a
        // per-actor feed this connector fetches — see docs §11.
        const c = rawCommentSchema.parse(raw);
        const message: CanonicalEntity = {
          kind: 'message',
          platform: 'LINKEDIN',
          externalId: c.id,
          occurredAt: new Date(c.created),
          sourceUrl: null,
          raw,
          parentExternalId: c.parentComment ?? null,
          rootExternalId: c.object,
          conversationExternalId: `post:${c.object}`,
          messageType: 'comment',
          direction: c.actor === ctx.accountExternalId ? 'outbound' : 'inbound',
          authorExternalId: c.actor,
          body: c.message.text,
          attachments: [],
          sentAt: new Date(c.created),
          editedAt: c.lastModified ? new Date(c.lastModified) : undefined,
        };
        return [message];
      }
      if (kind === KINDS.lead) {
        const l = rawLeadSchema.parse(raw);
        const firstName = findAnswer(l.answers, 'first name');
        const lastName = findAnswer(l.answers, 'last name');
        const fullNameAnswer = findAnswer(l.answers, 'full name');
        const combinedName = [firstName, lastName].filter(Boolean).join(' ');
        const fullName = fullNameAnswer ?? (combinedName || undefined);
        const emailRaw = findAnswer(l.answers, 'email', 'email address', 'work email');
        const phoneRaw = findAnswer(l.answers, 'phone number', 'phone', 'mobile phone number');
        const companyName = findAnswer(l.answers, 'company name', 'company');
        const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : undefined;
        const phone = phoneRaw && E164_RE.test(phoneRaw) ? phoneRaw : undefined;
        const lead: CanonicalEntity = {
          kind: 'lead',
          platform: 'LINKEDIN',
          externalId: l.id,
          occurredAt: new Date(l.submittedAt),
          sourceUrl: null,
          raw,
          source: 'lead_form',
          formExternalId: l.formId,
          formName: l.formName,
          submittedAt: new Date(l.submittedAt),
          fields: l.answers.map((a) => ({
            name: a.questionId,
            label: a.question,
            value: a.answer,
          })),
          fullName,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          companyName,
          campaignExternalId: l.campaign,
          consent:
            l.consentToMarketing !== undefined ? { marketing: l.consentToMarketing } : undefined,
        };
        return [lead];
      }
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound: none. Read-only this phase; LinkedIn also has no member-to-member DM API. ──
    async capabilities(ctx) {
      const v = await connector.verifyScopes(ctx);
      return linkedinManifest.capabilities.filter((c) => !v.degraded.includes(c));
    },
    async preflight(): Promise<Preflight> {
      return {
        ok: false,
        code: 'POLICY_BLOCKED',
        reason: 'LinkedIn is read-only in this connector',
        remediation: 'There is nothing to send on a LinkedIn connection.',
      };
    },
    async execute(): Promise<never> {
      throw new NexusError('POLICY_BLOCKED', { message: 'LinkedIn connections are read-only' });
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
        const bearer = await bearerOf(ctx);
        const res = await ctx.http.request({
          method: 'GET',
          url: url('/v2/userinfo'),
          headers: versionedHeaders(ctx, bearer),
          endpoint: 'GET /v2/userinfo',
          signal: ctx.signal,
          timeoutMs: 5_000,
        });
        userinfoResponseSchema.parse(res.json());
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
        .catch(() => ({ missing: [] as string[], degraded: [] as Capability[] }));
      const approvalMissing = APPROVAL_SCOPES.some((s) => scopes.missing.includes(s));
      checks.push({
        id: 'approval',
        ok: !approvalMissing,
        detail: approvalMissing
          ? `missing ${APPROVAL_SCOPES.filter((s) => scopes.missing.includes(s)).join(', ')}`
          : undefined,
        remediation: approvalMissing
          ? 'Apply for LinkedIn Marketing Developer Platform access — organization posts, comments and Lead Sync stay unavailable until approved.'
          : undefined,
      });
      if (approvalMissing && status === 'healthy') status = 'degraded';
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
