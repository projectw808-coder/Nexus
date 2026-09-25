/**
 * The RateLimiter (spec §7.3): one abstraction over the store serving the four quota shapes,
 * reserve-before-call / settle-after, observed-over-published usage, priority lanes and the
 * circuit breaker. Connectors see only a `BudgetHandle`; the sync engine and the health console
 * read `snapshot()`.
 *
 * Lanes: each lane may use up to a fraction of every window (backfill 60%, delta 85%,
 * webhook 95%, interactive 100%), so the cheap lanes leave headroom for the urgent ones and a
 * nightly backfill can never starve a rep's reply.
 */
import { NexusError, err, ok, type Result } from '@nexus/core';
import type { BudgetStore } from './budget-store.ts';
import {
  CircuitBreaker,
  breakerKey,
  type BreakerDoc,
  type BreakerOptions,
} from './circuit-breaker.ts';
import {
  LANES,
  LANE_PRIORITY,
  type BudgetSnapshot,
  type BudgetWindow,
  type Lane,
  type QuotaModel,
} from '../quota.ts';
import type {
  BudgetHandle,
  BudgetReservation,
  ObservedUsage,
  ReserveRequest,
  SettleOutcome,
} from '../spi.ts';

export const LANE_FRACTIONS: Readonly<Record<Lane, number>> = {
  interactive: 1,
  webhook: 0.95,
  delta: 0.85,
  backfill: 0.6,
};

export type SpendCap = { monthlyCapUnits: number; alertThresholdFraction?: number };

export type LimiterOptions = {
  store: BudgetStore;
  now?: () => number;
  random?: () => number;
  laneFractions?: Partial<Record<Lane, number>>;
  breaker?: BreakerOptions;
};

export type HandleParams = {
  connectionId: string;
  quota: QuotaModel;
  lane: Lane;
  spendCap?: SpendCap | null;
};

// ─── documents ──────────────────────────────────────────────────────────────

type WindowDoc = {
  used: number;
  reserved: number;
  /** Observed limit when a platform reported one; otherwise the published figure. */
  limit: number | null;
  source: 'published' | 'observed-header';
  /** Platform-reported reset, when known. */
  resetsAt: number | null;
  /** Hard stop from Retry-After / a 429; applies to every lane. */
  blockedUntil: number | null;
  /** Meta-style percentage. */
  observedPercent: number | null;
  observedAt: number | null;
};

type BucketsDoc = WindowDoc & { buckets: Record<string, number> };
type CounterDoc = { used: number; reserved: number };
type EndpointIndex = { endpoints: string[] };

const EMPTY_WINDOW: WindowDoc = {
  used: 0,
  reserved: 0,
  limit: null,
  source: 'published',
  resetsAt: null,
  blockedUntil: null,
  observedPercent: null,
  observedAt: null,
};

const DAY_MS = 86_400_000;
const BUCKET_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

// ─── time helpers ───────────────────────────────────────────────────────────

function tzParts(
  ms: number,
  timeZone: string,
): { y: number; m: number; d: number; h: number; mi: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const get = (type: string) =>
    Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

export function dayKeyIn(ms: number, timeZone: string): string {
  const p = tzParts(ms, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** UTC instant of the next local midnight in `timeZone`. */
export function nextMidnightIn(ms: number, timeZone: string): number {
  const p = tzParts(ms, timeZone);
  // Local midnight tomorrow expressed as if it were UTC, then corrected by the zone offset at that instant.
  const naive = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0);
  const q = tzParts(naive, timeZone);
  const asIfUtc = Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi, 0);
  const offset = asIfUtc - naive; // zone offset at `naive`
  return naive - offset;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function monthProgress(ms: number): number {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1e-6, (ms - start) / (end - start));
}

function rid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── the limiter ────────────────────────────────────────────────────────────

export class RateLimiter {
  readonly breaker: CircuitBreaker;
  private readonly store: BudgetStore;
  private readonly now: () => number;
  private readonly fractions: Record<Lane, number>;

  constructor(opts: LimiterOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.fractions = { ...LANE_FRACTIONS, ...opts.laneFractions };
    this.breaker = new CircuitBreaker(opts.store, {
      now: this.now,
      random: opts.random,
      ...opts.breaker,
    });
  }

  /** A per-(connection, lane) handle for one connector call site. */
  handle(p: HandleParams): BudgetHandle {
    return {
      reserve: (req) => this.reserve(p, req),
      settle: (reservation, outcome) => this.settle(p, reservation, outcome),
      snapshot: () => this.snapshot(p.connectionId, p.quota, p.spendCap ?? null),
    };
  }

  // ── keys ──
  private wk(conn: string, ...parts: (string | number)[]): string {
    return [`rl`, conn, ...parts].join(':');
  }

  private async rememberEndpoint(conn: string, endpoint: string): Promise<void> {
    await this.store.update<EndpointIndex, void>(this.wk(conn, 'endpoints'), 7 * DAY_MS, (cur) => {
      const set = new Set(cur?.endpoints ?? []);
      if (set.has(endpoint)) return { next: cur, result: undefined };
      set.add(endpoint);
      return { next: { endpoints: [...set].slice(-200) }, result: undefined };
    });
  }

  private refuse(
    code: 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'VALIDATION',
    p: HandleParams,
    req: ReserveRequest,
    resumesAt: number | null,
    detail: string,
  ): Result<BudgetReservation, NexusError> {
    return err(
      new NexusError(code, {
        message: detail,
        context: {
          resumesAt: resumesAt ? new Date(resumesAt) : undefined,
          resetsAt: resumesAt ? new Date(resumesAt) : undefined,
        },
        details: {
          connectionId: p.connectionId,
          endpoint: req.endpoint,
          lane: p.lane,
          cost: req.cost,
          reason: detail,
        },
      }),
    );
  }

  // ── reserve ──
  async reserve(
    p: HandleParams,
    req: ReserveRequest,
  ): Promise<Result<BudgetReservation, NexusError>> {
    const now = this.now();
    await this.rememberEndpoint(p.connectionId, req.endpoint);
    const reservation: BudgetReservation = {
      id: rid(),
      connectionId: p.connectionId,
      endpoint: req.endpoint,
      lane: p.lane,
      reservedCost: req.cost,
      reservedAt: new Date(now),
      ...(req.resourceKey ? { resourceKey: req.resourceKey } : {}),
    };
    const allowedFraction = this.fractions[p.lane];
    const q = p.quota;

    switch (q.kind) {
      case 'fixed_window': {
        const windowMs = q.windowSeconds * 1000;
        const start = Math.floor(now / windowMs) * windowMs;
        const published = q.perEndpoint?.[req.endpoint] ?? q.limit;
        if (q.maxConcurrent !== undefined) {
          const okConc = await this.store.update<CounterDoc, boolean>(
            this.wk(p.connectionId, 'conc'),
            10 * 60_000,
            (cur) => {
              const inflight = cur?.reserved ?? 0;
              if (inflight >= q.maxConcurrent!) return { next: cur, result: false };
              return { next: { used: 0, reserved: inflight + 1 }, result: true };
            },
          );
          if (!okConc)
            return this.refuse(
              'RATE_LIMITED',
              p,
              req,
              now + 250,
              `${q.maxConcurrent} requests already in flight`,
            );
        }
        const r = await this.store.update<WindowDoc, Result<BudgetReservation, NexusError>>(
          this.wk(p.connectionId, 'fw', req.endpoint, start),
          windowMs + 60_000,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            if (doc.blockedUntil !== null && now < doc.blockedUntil) {
              return {
                next: doc,
                result: this.refuse(
                  'RATE_LIMITED',
                  p,
                  req,
                  doc.blockedUntil,
                  'platform asked us to wait',
                ),
              };
            }
            const limit = doc.limit ?? published;
            const allowed = Math.floor(limit * allowedFraction);
            if (doc.used + doc.reserved + req.cost > allowed) {
              const resumesAt = doc.resetsAt ?? start + windowMs;
              return {
                next: doc,
                result: this.refuse(
                  'RATE_LIMITED',
                  p,
                  req,
                  resumesAt,
                  `${p.lane} lane has used its share of ${req.endpoint} this window`,
                ),
              };
            }
            return { next: { ...doc, reserved: doc.reserved + req.cost }, result: ok(reservation) };
          },
        );
        if (!r.ok && q.maxConcurrent !== undefined) await this.releaseConcurrency(p.connectionId);
        return r;
      }

      case 'rolling_hour': {
        return this.store.update<BucketsDoc, Result<BudgetReservation, NexusError>>(
          this.wk(p.connectionId, 'rh'),
          2 * HOUR_MS,
          (cur) => {
            const doc: BucketsDoc = { ...EMPTY_WINDOW, buckets: {}, ...cur };
            const buckets = pruneBuckets(doc.buckets, now);
            const used = Object.values(buckets).reduce((s, n) => s + n, 0);
            if (doc.blockedUntil !== null && now < doc.blockedUntil) {
              return {
                next: { ...doc, buckets },
                result: this.refuse(
                  'RATE_LIMITED',
                  p,
                  req,
                  doc.blockedUntil,
                  'platform asked us to wait',
                ),
              };
            }
            // Observed percentage beats our own count: above the backoff fraction only interactive work proceeds.
            if (
              doc.observedPercent !== null &&
              doc.observedAt !== null &&
              now - doc.observedAt < 15 * 60_000
            ) {
              const pct = doc.observedPercent / 100;
              if (pct >= 1 || (pct >= q.backoffAtFraction && p.lane !== 'interactive')) {
                return {
                  next: { ...doc, buckets },
                  result: this.refuse(
                    'RATE_LIMITED',
                    p,
                    req,
                    doc.observedAt + 15 * 60_000,
                    `platform reports ${doc.observedPercent}% of the hourly pool used`,
                  ),
                };
              }
            }
            const limit = doc.limit ?? q.limit;
            const allowed = Math.floor(limit * allowedFraction);
            if (used + doc.reserved + req.cost > allowed) {
              return {
                next: { ...doc, buckets },
                result: this.refuse(
                  'RATE_LIMITED',
                  p,
                  req,
                  oldestBucketExpiry(buckets, now),
                  `${p.lane} lane has used its share of the hourly pool`,
                ),
              };
            }
            return {
              next: { ...doc, buckets, reserved: doc.reserved + req.cost },
              result: ok(reservation),
            };
          },
        );
      }

      case 'daily_units': {
        const day = dayKeyIn(now, q.resetTimezone);
        const resetsAt = nextMidnightIn(now, q.resetTimezone);
        const unitCost = req.cost > 0 ? req.cost : (q.unitCosts[req.endpoint] ?? q.defaultUnitCost);
        reservation.reservedCost = unitCost;
        const cap = q.cappedEndpoints[req.endpoint];
        if (cap !== undefined) {
          const okCap = await this.store.update<CounterDoc, boolean>(
            this.wk(p.connectionId, 'du', day, 'cap', req.endpoint),
            DAY_MS + HOUR_MS,
            (cur) => {
              const doc = cur ?? { used: 0, reserved: 0 };
              if (doc.used + doc.reserved + 1 > Math.floor(cap * allowedFraction))
                return { next: doc, result: false };
              return { next: { ...doc, reserved: doc.reserved + 1 }, result: true };
            },
          );
          if (!okCap)
            return this.refuse(
              'QUOTA_EXHAUSTED',
              p,
              req,
              resetsAt,
              `${req.endpoint} has reached its ${cap} calls/day cap`,
            );
        }
        const r = await this.store.update<WindowDoc, Result<BudgetReservation, NexusError>>(
          this.wk(p.connectionId, 'du', day),
          DAY_MS + HOUR_MS,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            const limit = doc.limit ?? q.dailyUnits;
            if (doc.used + doc.reserved + unitCost > Math.floor(limit * allowedFraction)) {
              return {
                next: doc,
                result: this.refuse(
                  'QUOTA_EXHAUSTED',
                  p,
                  req,
                  resetsAt,
                  `${p.lane} lane has used its share of the daily units`,
                ),
              };
            }
            return {
              next: { ...doc, reserved: doc.reserved + unitCost, resetsAt },
              result: ok(reservation),
            };
          },
        );
        if (!r.ok && cap !== undefined) {
          await this.store.update<CounterDoc, void>(
            this.wk(p.connectionId, 'du', day, 'cap', req.endpoint),
            DAY_MS + HOUR_MS,
            (cur) => ({
              next: cur ? { ...cur, reserved: Math.max(0, cur.reserved - 1) } : null,
              result: undefined,
            }),
          );
        }
        return r;
      }

      case 'metered_credits': {
        if (!p.spendCap) {
          return this.refuse(
            'VALIDATION',
            p,
            req,
            null,
            'a monthly spend cap is required before this connection can make metered calls',
          );
        }
        const cycle = utcMonth(now);
        // 24h UTC dedup ledger: a re-read of the same resource today costs nothing.
        let cost = req.cost;
        if (req.resourceKey) {
          const seen = await this.store.get<{ at: number }>(
            this.wk(p.connectionId, 'dedup', req.resourceKey, utcDay(now)),
          );
          if (seen) cost = 0;
        }
        reservation.reservedCost = cost;
        const capUnits = p.spendCap.monthlyCapUnits;
        const alertFraction = p.spendCap.alertThresholdFraction ?? 0.8;
        const cycleEnd = Date.UTC(
          new Date(now).getUTCFullYear(),
          new Date(now).getUTCMonth() + 1,
          1,
        );
        return this.store.update<WindowDoc, Result<BudgetReservation, NexusError>>(
          this.wk(p.connectionId, 'mc', cycle),
          32 * DAY_MS,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            if (doc.blockedUntil !== null && now < doc.blockedUntil) {
              return {
                next: doc,
                result: this.refuse(
                  'RATE_LIMITED',
                  p,
                  req,
                  doc.blockedUntil,
                  'platform asked us to wait',
                ),
              };
            }
            const committed = doc.used + doc.reserved + cost;
            const hardCap = Math.min(capUnits, q.cycleCapUnits ?? Number.POSITIVE_INFINITY);
            if (committed > hardCap) {
              return {
                next: doc,
                result: this.refuse(
                  'QUOTA_EXHAUSTED',
                  p,
                  req,
                  cycleEnd,
                  `the monthly spend cap of ${capUnits} would be exceeded`,
                ),
              };
            }
            // Above the alert threshold, only the lanes a human is waiting on keep spending.
            if (
              committed > capUnits * alertFraction &&
              p.lane !== 'interactive' &&
              p.lane !== 'webhook'
            ) {
              return {
                next: doc,
                result: this.refuse(
                  'QUOTA_EXHAUSTED',
                  p,
                  req,
                  cycleEnd,
                  `spend is past ${Math.round(alertFraction * 100)}% of the monthly cap; background syncing paused`,
                ),
              };
            }
            return {
              next: { ...doc, reserved: doc.reserved + cost, resetsAt: cycleEnd },
              result: ok(reservation),
            };
          },
        );
      }
    }
  }

  private async releaseConcurrency(conn: string): Promise<void> {
    await this.store.update<CounterDoc, void>(this.wk(conn, 'conc'), 10 * 60_000, (cur) => ({
      next: cur ? { used: 0, reserved: Math.max(0, cur.reserved - 1) } : null,
      result: undefined,
    }));
  }

  // ── settle ──
  async settle(
    p: HandleParams,
    reservation: BudgetReservation,
    outcome: SettleOutcome,
  ): Promise<void> {
    const now = this.now();
    const actual = outcome.actualCost ?? reservation.reservedCost;
    const obs = outcome.observed;
    const q = p.quota;
    const applyObserved = (doc: WindowDoc): WindowDoc =>
      applyObservedUsage(doc, obs, outcome.httpStatus, now);

    switch (q.kind) {
      case 'fixed_window': {
        const windowMs = q.windowSeconds * 1000;
        const start = Math.floor(reservation.reservedAt.getTime() / windowMs) * windowMs;
        await this.store.update<WindowDoc, void>(
          this.wk(p.connectionId, 'fw', reservation.endpoint, start),
          windowMs + 60_000,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            return {
              next: applyObserved({
                ...doc,
                reserved: Math.max(0, doc.reserved - reservation.reservedCost),
                used: doc.used + actual,
              }),
              result: undefined,
            };
          },
        );
        if (q.maxConcurrent !== undefined) await this.releaseConcurrency(p.connectionId);
        return;
      }
      case 'rolling_hour': {
        await this.store.update<BucketsDoc, void>(
          this.wk(p.connectionId, 'rh'),
          2 * HOUR_MS,
          (cur) => {
            const doc: BucketsDoc = { ...EMPTY_WINDOW, buckets: {}, ...cur };
            const buckets = pruneBuckets(doc.buckets, now);
            const b = String(Math.floor(now / BUCKET_MS) * BUCKET_MS);
            buckets[b] = (buckets[b] ?? 0) + actual;
            const { buckets: _old, ...rest } = doc;
            const settled = applyObserved({
              ...rest,
              reserved: Math.max(0, doc.reserved - reservation.reservedCost),
            });
            return { next: { ...settled, buckets }, result: undefined };
          },
        );
        return;
      }
      case 'daily_units': {
        const day = dayKeyIn(reservation.reservedAt.getTime(), q.resetTimezone);
        await this.store.update<WindowDoc, void>(
          this.wk(p.connectionId, 'du', day),
          DAY_MS + HOUR_MS,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            return {
              next: applyObserved({
                ...doc,
                reserved: Math.max(0, doc.reserved - reservation.reservedCost),
                used: doc.used + actual,
              }),
              result: undefined,
            };
          },
        );
        if (q.cappedEndpoints[reservation.endpoint] !== undefined) {
          await this.store.update<CounterDoc, void>(
            this.wk(p.connectionId, 'du', day, 'cap', reservation.endpoint),
            DAY_MS + HOUR_MS,
            (cur) => {
              const doc = cur ?? { used: 0, reserved: 0 };
              return {
                next: { used: doc.used + 1, reserved: Math.max(0, doc.reserved - 1) },
                result: undefined,
              };
            },
          );
        }
        return;
      }
      case 'metered_credits': {
        const cycle = utcMonth(reservation.reservedAt.getTime());
        await this.store.update<WindowDoc, void>(
          this.wk(p.connectionId, 'mc', cycle),
          32 * DAY_MS,
          (cur) => {
            const doc = { ...EMPTY_WINDOW, ...cur };
            return {
              next: applyObserved({
                ...doc,
                reserved: Math.max(0, doc.reserved - reservation.reservedCost),
                used: doc.used + actual,
              }),
              result: undefined,
            };
          },
        );
        // Record the charge so a re-read of the same resource within the UTC day is free.
        if (
          actual > 0 &&
          reservation.resourceKey &&
          (outcome.httpStatus === undefined || outcome.httpStatus < 400)
        ) {
          await this.markCharged(p.connectionId, reservation.resourceKey);
        }
        return;
      }
    }
  }

  /** Mark a metered read as charged today (called by the handle wrapper that knows the resource key). */
  async markCharged(connectionId: string, resourceKey: string): Promise<void> {
    const now = this.now();
    await this.store.update<{ at: number }, void>(
      this.wk(connectionId, 'dedup', resourceKey, utcDay(now)),
      DAY_MS,
      () => ({ next: { at: now }, result: undefined }),
    );
  }

  // ── snapshot ──
  async snapshot(
    connectionId: string,
    quota: QuotaModel,
    spendCap: SpendCap | null,
  ): Promise<BudgetSnapshot> {
    const now = this.now();
    const windows: BudgetWindow[] = [];
    const endpoints =
      (await this.store.get<EndpointIndex>(this.wk(connectionId, 'endpoints')))?.endpoints ?? [];
    let projectedSpend: BudgetSnapshot['projectedSpend'];

    switch (quota.kind) {
      case 'fixed_window': {
        const windowMs = quota.windowSeconds * 1000;
        const start = Math.floor(now / windowMs) * windowMs;
        for (const ep of endpoints) {
          const doc = await this.store.get<WindowDoc>(this.wk(connectionId, 'fw', ep, start));
          const limit = doc?.limit ?? quota.perEndpoint?.[ep] ?? quota.limit;
          windows.push(toWindow(`${quota.windowSeconds / 60}m`, ep, limit, doc, start + windowMs));
        }
        if (endpoints.length === 0)
          windows.push(
            toWindow(
              `${quota.windowSeconds / 60}m`,
              undefined,
              quota.limit,
              null,
              start + windowMs,
            ),
          );
        break;
      }
      case 'rolling_hour': {
        const doc = await this.store.get<BucketsDoc>(this.wk(connectionId, 'rh'));
        const used = doc
          ? Object.values(pruneBuckets(doc.buckets, now)).reduce((s, n) => s + n, 0)
          : 0;
        const limit = doc?.limit ?? quota.limit;
        windows.push({
          id: '1h',
          limit,
          used,
          remaining: Math.max(0, limit - used),
          resetsAt: doc ? new Date(oldestBucketExpiry(doc.buckets, now)) : null,
          source: doc?.source ?? 'published',
        });
        break;
      }
      case 'daily_units': {
        const day = dayKeyIn(now, quota.resetTimezone);
        const doc = await this.store.get<WindowDoc>(this.wk(connectionId, 'du', day));
        windows.push(
          toWindow(
            'day-units',
            undefined,
            doc?.limit ?? quota.dailyUnits,
            doc,
            nextMidnightIn(now, quota.resetTimezone),
          ),
        );
        for (const [ep, cap] of Object.entries(quota.cappedEndpoints)) {
          const c = await this.store.get<CounterDoc>(this.wk(connectionId, 'du', day, 'cap', ep));
          windows.push({
            id: ep,
            endpoint: ep,
            limit: cap,
            used: c?.used ?? 0,
            remaining: Math.max(0, cap - (c?.used ?? 0)),
            resetsAt: new Date(nextMidnightIn(now, quota.resetTimezone)),
            source: 'published',
          });
        }
        break;
      }
      case 'metered_credits': {
        const doc = await this.store.get<WindowDoc>(this.wk(connectionId, 'mc', utcMonth(now)));
        const cap = spendCap?.monthlyCapUnits ?? quota.cycleCapUnits ?? null;
        const used = doc?.used ?? 0;
        windows.push({
          id: 'cycle-credits',
          limit: cap ?? Number.POSITIVE_INFINITY,
          used,
          remaining: cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - used),
          resetsAt: null,
          source: doc?.source ?? 'published',
        });
        projectedSpend = {
          currency: quota.currency,
          spentUnits: used,
          projectedCycleUnits: used / monthProgress(now),
          capUnits: cap,
          alertThresholdUnits: spendCap
            ? spendCap.monthlyCapUnits * (spendCap.alertThresholdFraction ?? 0.8)
            : null,
        };
        break;
      }
    }

    const circuits: BudgetSnapshot['circuits'] = {};
    for (const ep of endpoints) {
      const doc = await this.store.get<BreakerDoc>(breakerKey(connectionId, ep));
      if (doc && doc.state !== 'closed')
        circuits[ep] = {
          state: doc.state,
          until: doc.until ? new Date(doc.until) : null,
          consecutiveFailures: doc.consecutiveFailures,
        };
    }

    const primary = windows[0];
    let throttledFromLane: Lane | null = null;
    if (primary && Number.isFinite(primary.limit)) {
      for (const lane of [...LANES].sort((a, b) => LANE_PRIORITY[a] - LANE_PRIORITY[b])) {
        if (primary.used >= Math.floor(primary.limit * this.fractions[lane])) {
          throttledFromLane = lane;
          break;
        }
      }
    }

    return {
      connectionId,
      quotaKind: quota.kind,
      windows,
      projectedSpend,
      circuits,
      throttledFromLane,
      asOf: new Date(now),
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function pruneBuckets(buckets: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(buckets)) if (now - Number(k) < HOUR_MS) out[k] = v;
  return out;
}

function oldestBucketExpiry(buckets: Record<string, number>, now: number): number {
  const keys = Object.keys(buckets).map(Number);
  if (keys.length === 0) return now + BUCKET_MS;
  return Math.min(...keys) + HOUR_MS;
}

function applyObservedUsage(
  doc: WindowDoc,
  obs: ObservedUsage | undefined,
  status: number | undefined,
  now: number,
): WindowDoc {
  let next = { ...doc };
  if (obs) {
    if (obs.limit !== undefined) next = { ...next, limit: obs.limit, source: 'observed-header' };
    if (obs.remaining !== undefined) {
      const limit = next.limit ?? doc.limit;
      if (limit !== null)
        next = {
          ...next,
          used: Math.max(next.used, limit - obs.remaining),
          source: 'observed-header',
        };
    }
    if (obs.resetsAt)
      next = { ...next, resetsAt: obs.resetsAt.getTime(), source: 'observed-header' };
    if (obs.percentUsed !== undefined)
      next = {
        ...next,
        observedPercent: obs.percentUsed,
        observedAt: now,
        source: 'observed-header',
      };
    if (obs.retryAfter)
      next = { ...next, blockedUntil: obs.retryAfter.getTime(), source: 'observed-header' };
  }
  if (status === 429 && next.blockedUntil === null) {
    // No Retry-After: hold everyone for a minute rather than hammer.
    next = { ...next, blockedUntil: now + 60_000 };
  }
  return next;
}

function toWindow(
  id: string,
  endpoint: string | undefined,
  limit: number,
  doc: WindowDoc | null,
  defaultReset: number,
): BudgetWindow {
  const used = doc?.used ?? 0;
  return {
    id,
    endpoint,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: new Date(doc?.resetsAt ?? defaultReset),
    source: doc?.source ?? 'published',
  };
}
