/**
 * Keitaro TDS connector (spec §8.6). Every connection points at a different customer-owned
 * tracker (`ctx.settings.baseUrl`), authenticated with a per-connection API key (`Api-Key`
 * header) — there is no OAuth flow, no shared app, no platform-published rate limit. Read-only:
 * `execute`/`preflight` always refuse, because Keitaro feeds Deal attribution, not the inbox.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  observedFromHeaders,
  verifySharedSecret,
  type BudgetHandle,
  type CanonicalEntity,
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
import { keitaroManifest, KINDS } from './manifest.ts';

export type KeitaroConfig = Record<string, never>;

// ─── raw shapes ─────────────────────────────────────────────────────────────
// `.passthrough()` on purpose: Keitaro echoes whichever of sub_id_1..sub_id_30 the customer's
// tracker populated, which varies per connection and per click — that variability is real data,
// not drift, and the sub_id mapping UI (§8.6) is what interprets it.

const namedRefSchema = z
  .object({ id: z.union([z.string(), z.number()]).nullable(), name: z.string().nullable() })
  .nullable()
  .optional();

const rawConversionSchema = z
  .object({
    conversion_id: z.union([z.string(), z.number()]),
    subid: z.string(),
    tid: z.string().default(''),
    status: z.string(),
    previous_status: z.string().nullable().optional(),
    payout: z.coerce.number(),
    revenue: z.coerce.number().optional(),
    cost: z.coerce.number().optional(),
    currency: z.string().length(3),
    campaign: namedRefSchema,
    source: namedRefSchema,
    offer: namedRefSchema,
    affiliate_network: namedRefSchema,
    stream: namedRefSchema,
    landing: namedRefSchema,
    country: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    device_type: z.string().nullable().optional(),
    os: z.string().nullable().optional(),
    browser: z.string().nullable().optional(),
    creative_id: z.union([z.string(), z.number()]).nullable().optional(),
    creative_name: z.string().nullable().optional(),
    click_datetime: z.string().nullable().optional(),
    postback_datetime: z.string(),
  })
  .passthrough();

const rawCampaignSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    state: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const conversionsResponseSchema = z.object({
  rows: z.array(z.unknown()),
});
const campaignsResponseSchema = z.object({ rows: z.array(z.unknown()) });
const webhookBodySchema = z.object({ subid: z.string() }).passthrough();

const idOf = (v: string | number | null | undefined): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

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

function baseUrlOf(ctx: ConnCtx<KeitaroConfig>): string {
  const url = ctx.settings.baseUrl;
  if (!url)
    throw new NexusError('VALIDATION', {
      message: 'this connection has no tracker base URL configured',
    });
  return url.replace(/\/+$/, '');
}

async function apiKeyHeader(ctx: ConnCtx<KeitaroConfig>): Promise<Record<string, string>> {
  return { 'Api-Key': (await ctx.token()).accessToken };
}

export function createKeitaroConnector(_config: KeitaroConfig = {}): Connector<KeitaroConfig> {
  const connector: Connector<KeitaroConfig> = {
    manifest: keitaroManifest,

    // ── auth: api_key, no redirect flow ──
    buildAuthUrl(): string {
      throw new NexusError('VALIDATION', {
        message: 'Keitaro connects with a per-connection API key, not an OAuth redirect.',
      });
    },
    async exchangeCode(): Promise<never> {
      throw new NexusError('VALIDATION', {
        message: 'Keitaro connects with a per-connection API key, not an OAuth redirect.',
      });
    },
    async refresh(): Promise<never> {
      throw new NexusError('AUTH_EXPIRED', {
        message: 'API keys do not refresh',
        context: { reason: 'Regenerate the key in your Keitaro admin panel and reconnect.' },
      });
    },
    async revoke(): Promise<void> {
      // Best-effort only (§5.4): Keitaro has no revoke endpoint. The vault entry is deleted
      // regardless by the caller; nothing platform-side to undo.
    },
    async discoverAccounts(ctx): Promise<DiscoveredAccount[]> {
      const base = baseUrlOf(ctx);
      let host = base;
      try {
        host = new URL(base).host;
      } catch {
        // keep the raw string if it does not parse as a URL
      }
      return [
        {
          externalId: host,
          platform: 'KEITARO',
          name: host,
          handle: null,
          avatarUrl: null,
          accountType: 'tracker',
          hasOwnToken: false,
          parentExternalId: null,
          raw: { baseUrl: base },
        },
      ];
    },
    async verifyScopes(): Promise<ScopeVerification> {
      // A single API key grants everything it is scoped to in the Keitaro admin panel; Keitaro
      // has no scope-introspection endpoint, so a 401/403 on first use is the only signal (§8.6:
      // "There is no refresh; a 401 means AUTH_EXPIRED"), surfaced through `health()` instead.
      return { missing: [], degraded: [] };
    },

    // ── ingest ──
    listResources() {
      return keitaroManifest.resources;
    },
    async fetchPage(ctx, r: ResourceRef, cursor?: string): Promise<RawPage> {
      const base = baseUrlOf(ctx);
      const headers = await apiKeyHeader(ctx);
      // Keitaro publishes no page-size limit; default small enough that a modest backlog still
      // pages (the platform double relies on this to exercise cursor resumption realistically).
      const limit = r.pageSize ?? 10;
      const offset = cursor ? Number(cursor) : 0;

      if (r.id === 'keitaro.conversions') {
        const endpoint = 'POST /admin_api/v1/conversions/log';
        const since = r.highWaterMark ?? r.since;
        const body = await withBudget(ctx.budget, endpoint, async () => {
          const res = await ctx.http.request({
            method: 'POST',
            url: `${base}/admin_api/v1/conversions/log`,
            headers,
            body: {
              limit,
              offset,
              from: since ? since.toISOString() : undefined,
            },
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: conversionsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        let hwm: Date | undefined;
        const items = body.rows.map((raw) => {
          const c = rawConversionSchema.parse(raw);
          const at = new Date(c.postback_datetime);
          if (!Number.isNaN(at.getTime()) && (!hwm || at > hwm)) hwm = at;
          return {
            kind: KINDS.conversion,
            externalId: String(c.conversion_id),
            raw,
            occurredAt: Number.isNaN(at.getTime()) ? undefined : at,
          };
        });
        return {
          items,
          nextCursor: items.length === limit ? String(offset + limit) : null,
          budgetSpent: 1,
          highWaterMark: hwm,
        };
      }

      if (r.id === 'keitaro.campaigns') {
        const endpoint = 'GET /admin_api/v1/campaigns';
        const body = await withBudget(ctx.budget, endpoint, async () => {
          const res = await ctx.http.request({
            method: 'GET',
            url: `${base}/admin_api/v1/campaigns`,
            query: { limit, offset },
            headers,
            endpoint,
            signal: ctx.signal,
          });
          return {
            value: campaignsResponseSchema.parse(res.json()),
            headers: res.headers,
            status: res.status,
          };
        });
        const items = body.rows.map((raw) => {
          const c = rawCampaignSchema.parse(raw);
          return { kind: KINDS.campaign, externalId: String(c.id), raw };
        });
        return {
          items,
          nextCursor: items.length === limit ? String(offset + limit) : null,
          budgetSpent: 1,
        };
      }

      if (r.id === 'keitaro.clicks') {
        // Off by default (§8.6); when enabled only converted/filtered clicks sync — the sync
        // engine applies `settings.clickFilter` before scheduling this resource at all, so
        // reaching here with no filter configured is a caller error, not a platform one.
        throw new NexusError('VALIDATION', {
          message: 'keitaro.clicks requires a click filter — see ConnectionSettings.clickFilter',
        });
      }

      throw new NexusError('VALIDATION', { message: `unknown resource ${r.id}` });
    },
    verifyWebhook(req: WebhookRequest, secret: string): boolean {
      return verifySharedSecret(req.query['key'], secret);
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
      const c = rawConversionSchema.safeParse(body.data);
      if (!c.success) return [];
      const m = /\/webhooks\/keitaro\/([^/?]+)/.exec(req.path);
      return [
        {
          kind: KINDS.conversion,
          externalId: String(c.data.conversion_id),
          raw: body.data,
          receivedAt: new Date(),
          connectionHint: { platform: 'KEITARO', connectionId: m?.[1] },
        },
      ];
    },
    async subscribeWebhooks(): Promise<void> {
      // Keitaro has no subscription API — the user pastes the postback URL into their tracker's
      // campaign/offer settings by hand. Idempotent no-op, per the SPI contract.
    },

    // ── normalize (pure) ──
    normalize(kind, raw, ctx: NormalizeCtx): CanonicalEntity[] {
      if (kind === KINDS.conversion) {
        const c = rawConversionSchema.parse(raw);
        const subIds: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (/^sub_id_\d+$/.test(key) && (typeof value === 'string' || value === null)) {
            subIds[key] = value;
          }
        }
        const namedRef = (r: typeof c.campaign) =>
          r && (r.id !== null || r.name !== null)
            ? { externalId: idOf(r.id) ?? r.name ?? '', name: r.name ?? null }
            : null;
        const postbackAt = new Date(c.postback_datetime);
        const clickedAt = c.click_datetime ? new Date(c.click_datetime) : null;
        const entity: CanonicalEntity = {
          kind: 'conversion',
          platform: 'KEITARO',
          externalId: String(c.conversion_id),
          occurredAt: postbackAt,
          sourceUrl: null,
          raw,
          subid: c.subid,
          tid: c.tid,
          status: c.status,
          previousStatus: c.previous_status ?? null,
          payout: c.payout,
          revenue: c.revenue,
          cost: c.cost,
          currency: c.currency.toUpperCase(),
          subIds,
          campaign: namedRef(c.campaign),
          source: namedRef(c.source),
          offer: namedRef(c.offer),
          affiliateNetwork: namedRef(c.affiliate_network),
          stream: namedRef(c.stream),
          landing: namedRef(c.landing),
          geo: c.country
            ? { country: c.country, region: c.region ?? undefined, city: c.city ?? undefined }
            : null,
          device:
            c.device_type || c.os || c.browser
              ? {
                  type: c.device_type ?? undefined,
                  os: c.os ?? undefined,
                  browser: c.browser ?? undefined,
                }
              : null,
          creative:
            c.creative_id || c.creative_name
              ? { id: idOf(c.creative_id), name: c.creative_name ?? undefined }
              : null,
          clickedAt: clickedAt && !Number.isNaN(clickedAt.getTime()) ? clickedAt : null,
          postbackAt,
        };
        return [entity];
      }
      if (kind === KINDS.campaign) {
        // Slow-changing configuration dimension; not attached to a person or a Deal directly,
        // so it normalizes to a metric-shaped record for the reports pipeline rather than
        // inventing a "campaign" canonical kind for one connector.
        const c = rawCampaignSchema.parse(raw);
        return [
          {
            kind: 'metric',
            platform: 'KEITARO',
            externalId: `campaign:${c.id}`,
            occurredAt: c.updated_at ? new Date(c.updated_at) : ctx.fetchedAt,
            sourceUrl: null,
            raw,
            subjectKind: 'campaign',
            subjectExternalId: String(c.id),
            metric: 'campaign_state',
            value: c.state === 'active' ? 1 : 0,
            period: { start: ctx.fetchedAt, end: ctx.fetchedAt, granularity: 'lifetime' },
            dimensions: { name: c.name, state: c.state ?? 'unknown' },
          },
        ];
      }
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
    },

    // ── outbound: none. Keitaro feeds Deal attribution, not the inbox (§8.6). ──
    async capabilities() {
      return keitaroManifest.capabilities;
    },
    async preflight(): Promise<Preflight> {
      return {
        ok: false,
        code: 'POLICY_BLOCKED',
        reason: 'Keitaro is a read-only attribution source',
        remediation: 'There is nothing to send on a Keitaro connection.',
      };
    },
    async execute(): Promise<never> {
      throw new NexusError('POLICY_BLOCKED', { message: 'Keitaro connections are read-only' });
    },

    // ── health ──
    async budget(ctx) {
      return ctx.budget.snapshot();
    },
    async health(ctx): Promise<HealthReport> {
      const checks: HealthReport['checks'] = [];
      let status: HealthReport['status'] = 'healthy';
      let lastError: HealthReport['lastError'] = null;
      try {
        const base = baseUrlOf(ctx);
        const headers = await apiKeyHeader(ctx);
        const res = await ctx.http.request({
          method: 'GET',
          url: `${base}/admin_api/v1/campaigns`,
          query: { limit: 1 },
          headers,
          endpoint: 'GET /admin_api/v1/campaigns',
          signal: ctx.signal,
          timeoutMs: 8_000,
        });
        campaignsResponseSchema.parse(res.json());
        checks.push({ id: 'reachability', ok: true });
        checks.push({ id: 'token', ok: true });
      } catch (e) {
        const code = e instanceof NexusError ? e.code : 'PLATFORM_DOWN';
        checks.push({
          id: code === 'AUTH_EXPIRED' ? 'token' : 'reachability',
          ok: false,
          failureClass: code,
          detail: e instanceof Error ? e.message : String(e),
          remediation:
            code === 'AUTH_EXPIRED'
              ? 'Regenerate the API key in your Keitaro admin panel and reconnect.'
              : 'Confirm the tracker base URL is reachable from this server.',
        });
        lastError = { code, message: e instanceof Error ? e.message : String(e), at: new Date() };
        status = code === 'AUTH_EXPIRED' ? 'reconnect_required' : 'down';
      }
      return {
        status,
        checks,
        tokenExpiresAt: null,
        degradedCapabilities: [],
        lastError,
        checkedAt: new Date(),
      };
    },
  };
  return connector;
}
