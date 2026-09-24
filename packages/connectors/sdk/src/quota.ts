import { z } from 'zod';

// ─── Priority lanes (§7.3) ───────────────────────────────────────────────────

/**
 * Work lanes, in strict priority order. `interactive` means a human is waiting
 * (a rep pressing Send, a user-initiated search); `webhook` is inbound push
 * processing; `delta` is the scheduled incremental poll; `backfill` is the
 * initial / repair bulk load. Backfill yields budget to every lane above it —
 * a nightly backfill must never starve a DM reply.
 */
export const LANES = ['interactive', 'webhook', 'delta', 'backfill'] as const;

export type Lane = (typeof LANES)[number];

export const laneSchema = z.enum(LANES);

/**
 * Lower number = higher priority. When budget is scarce the limiter serves the
 * lowest-numbered lane that has queued work.
 */
export const LANE_PRIORITY: Readonly<Record<Lane, number>> = {
  interactive: 0,
  webhook: 1,
  delta: 2,
  backfill: 3,
};

// ─── Quota models (§7.3) — the four shapes the RateLimiter serves ───────────

/**
 * An endpoint identifier as the connector names it in its manifest and in
 * `budget.reserve()` — e.g. `GET /2/users/:id/mentions`, `search.list`,
 * `POST /admin_api/v1/conversions/log`. Free-form, but stable per connector.
 */
export const endpointIdSchema = z.string().min(1);

/**
 * Fixed window per N seconds. Used by X (per-15-minute endpoint limits) and as
 * the conservative client-side limiter for Keitaro (no published limit; default
 * 2 req/s, 2 concurrent — §8.6). Redis counter keyed `(conn, endpoint, window)`.
 */
export const fixedWindowQuotaSchema = z.object({
  kind: z.literal('fixed_window'),
  /** Length of the window in seconds (X: 900). */
  windowSeconds: z.number().int().positive(),
  /** Default calls per window when `perEndpoint` has no entry. */
  limit: z.number().int().positive(),
  /** Endpoint-specific overrides of `limit`. */
  perEndpoint: z.record(endpointIdSchema, z.number().int().positive()).optional(),
  /** Optional in-flight concurrency cap in addition to the window (Keitaro: 2). */
  maxConcurrent: z.number().int().positive().optional(),
});

/**
 * Rolling call count per hour. Used by Meta (per-app / per-user / per-page
 * pools). Sliding-window log, driven by the platform's own usage headers where
 * returned — observed headers always beat the published `limit`.
 */
export const rollingHourQuotaSchema = z.object({
  kind: z.literal('rolling_hour'),
  /** Published calls-per-hour figure, used only until a usage header is seen. */
  limit: z.number().int().positive(),
  /** Response headers that carry usage (Meta: `X-App-Usage`, `X-Business-Use-Case-Usage`). */
  headerNames: z.array(z.string().min(1)).min(1),
  /** Back off when any pool crosses this fraction (Meta guidance: 0.8). */
  backoffAtFraction: z.number().gt(0).lte(1).default(0.8),
});

/**
 * Daily unit cost plus per-endpoint hard call caps. Used by YouTube Data API:
 * 10,000 units/day resetting at midnight Pacific, reads = 1 unit, writes = 50,
 * and `search.list` / `videos.insert` each in a separate 100-calls/day bucket.
 * A call is refused if EITHER the unit bucket OR the endpoint's call cap is
 * exhausted (§8.5).
 */
export const dailyUnitsQuotaSchema = z.object({
  kind: z.literal('daily_units'),
  dailyUnits: z.number().int().positive(),
  /** IANA zone the daily reset is computed in (YouTube: `America/Los_Angeles`). */
  resetTimezone: z.string().min(1),
  /** Units charged per endpoint (missing endpoints default to `defaultUnitCost`). */
  unitCosts: z.record(endpointIdSchema, z.number().int().nonnegative()),
  defaultUnitCost: z.number().int().nonnegative().default(1),
  /** Endpoint → maximum calls per day, tracked independently of the unit bucket. */
  cappedEndpoints: z.record(endpointIdSchema, z.number().int().positive()),
});

/**
 * Metered credits with de-duplication. Used by X pay-per-use, TikTok and
 * LinkedIn tiers. Monotonic cycle counter + spend projection + a 24h UTC dedup
 * ledger keyed `(connectionId, resourceId, utcDay)` so re-reads inside the
 * window are charged once (§8.2). A monthly spend cap is a REQUIRED setup
 * field on every connection using this shape.
 */
export const meteredCreditsQuotaSchema = z.object({
  kind: z.literal('metered_credits'),
  /** ISO-4217 code the rate card is expressed in. */
  currency: z.string().length(3),
  /** Operation → cost per call in `currency` (X: post read 0.005, URL-bearing write 0.2 …). */
  rateCard: z.record(endpointIdSchema, z.number().nonnegative()),
  /** Hard ceiling per billing cycle before an Enterprise plan is required (X: ~3M post reads). */
  cycleCapUnits: z.number().positive().optional(),
  dedupWindowHours: z.literal(24),
  spendCapRequired: z.literal(true),
});

export const quotaModelSchema = z.discriminatedUnion('kind', [
  fixedWindowQuotaSchema,
  rollingHourQuotaSchema,
  dailyUnitsQuotaSchema,
  meteredCreditsQuotaSchema,
]);

export type FixedWindowQuota = z.infer<typeof fixedWindowQuotaSchema>;
export type RollingHourQuota = z.infer<typeof rollingHourQuotaSchema>;
export type DailyUnitsQuota = z.infer<typeof dailyUnitsQuotaSchema>;
export type MeteredCreditsQuota = z.infer<typeof meteredCreditsQuotaSchema>;
export type QuotaModel = z.infer<typeof quotaModelSchema>;
export type QuotaKind = QuotaModel['kind'];

export const QUOTA_KINDS = [
  'fixed_window',
  'rolling_hour',
  'daily_units',
  'metered_credits',
] as const satisfies readonly QuotaKind[];

// ─── Budget snapshot (returned by Connector.budget and BudgetHandle.snapshot) ─

/** Where a budget figure came from — persisted to `RateBudget.source`. */
export type BudgetSource = 'published' | 'observed-header';

/** One window / pool / bucket of the connection's budget. */
export interface BudgetWindow {
  /** Stable id: `"15m"`, `"1h"`, `"day-units"`, `"cycle-credits"`, or an endpoint id for capped endpoints. */
  id: string;
  /** Endpoint this window is scoped to, when not connection-wide. */
  endpoint?: string;
  limit: number;
  used: number;
  remaining: number;
  /** `null` for cycle counters that reset on the platform's billing date and are unknown locally. */
  resetsAt: Date | null;
  source: BudgetSource;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Point-in-time view of a connection's budget, shown in the connection header
 * and used by the quota simulator. Every field is derived from the limiter's
 * store; connectors never compute it themselves.
 */
export interface BudgetSnapshot {
  connectionId: string;
  quotaKind: QuotaKind;
  windows: BudgetWindow[];
  /** Only for `metered_credits`: projected spend for the current cycle. */
  projectedSpend?: {
    currency: string;
    spentUnits: number;
    projectedCycleUnits: number;
    capUnits: number | null;
    alertThresholdUnits: number | null;
  };
  /** Circuit breaker state per endpoint (§7.3); absent endpoints are `closed`. */
  circuits: Record<
    string,
    { state: CircuitState; until: Date | null; consecutiveFailures: number }
  >;
  /** Highest lane currently being throttled, or `null` when nothing is throttled. */
  throttledFromLane: Lane | null;
  asOf: Date;
}
