import { describe, expect, it } from 'vitest';
import type { NexusError } from '@nexus/core';
import type { QuotaModel } from '../quota.ts';
import type { BudgetReservation } from '../spi.ts';
import { MemoryBudgetStore } from './budget-store.ts';
import { RateLimiter, dayKeyIn, nextMidnightIn } from './rate-limiter.ts';

function clock(start = Date.UTC(2026, 8, 24, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

function limiterAt(c: ReturnType<typeof clock>) {
  const store = new MemoryBudgetStore(c.now);
  return { limiter: new RateLimiter({ store, now: c.now, random: () => 0.5 }), store };
}

const conn = 'conn_1';

async function reserveOk(
  h: ReturnType<RateLimiter['handle']>,
  endpoint: string,
  cost = 1,
  resourceKey?: string,
): Promise<BudgetReservation> {
  const r = await h.reserve({ endpoint, cost, resourceKey });
  if (!r.ok) throw r.error;
  return r.value;
}

async function reserveErr(
  h: ReturnType<RateLimiter['handle']>,
  endpoint: string,
  cost = 1,
): Promise<NexusError> {
  const r = await h.reserve({ endpoint, cost });
  if (r.ok) throw new Error('expected refusal');
  return r.error;
}

describe('fixed window', () => {
  const quota: QuotaModel = {
    kind: 'fixed_window',
    windowSeconds: 900,
    limit: 10,
    perEndpoint: { 'GET /small': 4 },
  };

  it('serves lanes by fraction and refuses with a resume time at the window end', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const backfill = limiter.handle({ connectionId: conn, quota, lane: 'backfill' });
    const interactive = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    // backfill may use 60% of 10 = 6
    for (let i = 0; i < 6; i++) {
      const res = await reserveOk(backfill, 'GET /x');
      await backfill.settle(res, {});
    }
    const refused = await reserveErr(backfill, 'GET /x');
    expect(refused.code).toBe('RATE_LIMITED');
    expect(refused.context.resumesAt!.getTime()).toBe(
      Math.floor(c.now() / 900_000) * 900_000 + 900_000,
    );
    // interactive still has the remaining 4
    for (let i = 0; i < 4; i++)
      await interactive.settle(await reserveOk(interactive, 'GET /x'), {});
    expect((await reserveErr(interactive, 'GET /x')).code).toBe('RATE_LIMITED');
    // a new window clears it
    c.advance(900_000);
    await reserveOk(backfill, 'GET /x');
  });

  it('honours per-endpoint limits and observed headers over the published figure', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const h = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    for (let i = 0; i < 4; i++) await h.settle(await reserveOk(h, 'GET /small'), {});
    expect((await reserveErr(h, 'GET /small')).code).toBe('RATE_LIMITED');
    // The platform says a larger limit with plenty remaining → trust it.
    const res = await reserveOk(h, 'GET /x');
    await h.settle(res, { observed: { limit: 100, remaining: 90 } });
    const snap = await h.snapshot();
    const w = snap.windows.find((x) => x.endpoint === 'GET /x')!;
    expect(w.limit).toBe(100);
    expect(w.used).toBe(10);
    expect(w.source).toBe('observed-header');
  });

  it('blocks every lane until Retry-After after a 429', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const h = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    const res = await reserveOk(h, 'GET /x');
    await h.settle(res, { httpStatus: 429, observed: { retryAfter: new Date(c.now() + 30_000) } });
    const e = await reserveErr(h, 'GET /x');
    expect(e.context.resumesAt!.getTime()).toBe(c.now() + 30_000);
    c.advance(31_000);
    await reserveOk(h, 'GET /x');
  });

  it('caps concurrency when the quota declares it', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const q: QuotaModel = { kind: 'fixed_window', windowSeconds: 1, limit: 100, maxConcurrent: 2 };
    const h = limiter.handle({ connectionId: conn, quota: q, lane: 'delta' });
    const a = await reserveOk(h, 'GET /x');
    await reserveOk(h, 'GET /x');
    expect((await reserveErr(h, 'GET /x')).details.reason).toMatch(/in flight/);
    await h.settle(a, {});
    await reserveOk(h, 'GET /x');
  });
});

describe('rolling hour', () => {
  const quota: QuotaModel = {
    kind: 'rolling_hour',
    limit: 100,
    headerNames: ['x-app-usage'],
    backoffAtFraction: 0.8,
  };

  it('counts a sliding hour and lets old buckets expire', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const h = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    for (let i = 0; i < 100; i++) await h.settle(await reserveOk(h, 'GET /x'), {});
    expect((await reserveErr(h, 'GET /x')).code).toBe('RATE_LIMITED');
    c.advance(61 * 60_000);
    await reserveOk(h, 'GET /x');
  });

  it('throttles background lanes when the platform reports usage above the backoff fraction', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const delta = limiter.handle({ connectionId: conn, quota, lane: 'delta' });
    const interactive = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    const r = await reserveOk(delta, 'GET /x');
    await delta.settle(r, { observed: { percentUsed: 85 } });
    expect((await reserveErr(delta, 'GET /x')).details.reason).toMatch(/85%/);
    await reserveOk(interactive, 'GET /x');
    // 100% stops everyone
    const r2 = await reserveOk(interactive, 'GET /x');
    await interactive.settle(r2, { observed: { percentUsed: 100 } });
    expect((await reserveErr(interactive, 'GET /x')).code).toBe('RATE_LIMITED');
  });
});

describe('daily units', () => {
  const quota: QuotaModel = {
    kind: 'daily_units',
    dailyUnits: 100,
    resetTimezone: 'America/Los_Angeles',
    unitCosts: { 'videos.insert': 50, 'search.list': 1 },
    defaultUnitCost: 1,
    cappedEndpoints: { 'search.list': 3 },
  };

  it('charges units per endpoint and refuses when either the units or the endpoint cap are gone', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const h = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    // 3 search calls fit the cap; the 4th is refused even though units remain
    for (let i = 0; i < 3; i++) await h.settle(await reserveOk(h, 'search.list', 0), {});
    const e = await reserveErr(h, 'search.list', 0);
    expect(e.code).toBe('QUOTA_EXHAUSTED');
    expect(e.details.reason).toMatch(/calls\/day/);
    expect(e.context.resetsAt!.getTime()).toBe(nextMidnightIn(c.now(), 'America/Los_Angeles'));
    // 50 + 50 units for inserts, then nothing left (3 already spent by search)
    await h.settle(await reserveOk(h, 'videos.insert', 0), {});
    expect((await reserveErr(h, 'videos.insert', 0)).code).toBe('QUOTA_EXHAUSTED');
    const snap = await h.snapshot();
    expect(snap.windows[0]).toMatchObject({ id: 'day-units', used: 53, limit: 100 });
    expect(snap.windows.find((w) => w.id === 'search.list')).toMatchObject({ used: 3, limit: 3 });
  });

  it('resets at local midnight in the quota timezone', () => {
    const noonUtc = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(dayKeyIn(noonUtc, 'America/Los_Angeles')).toBe('2026-09-24');
    const reset = nextMidnightIn(noonUtc, 'America/Los_Angeles');
    // Midnight PDT (UTC-7) on 25 Sep = 07:00Z
    expect(new Date(reset).toISOString()).toBe('2026-09-25T07:00:00.000Z');
    expect(dayKeyIn(reset, 'America/Los_Angeles')).toBe('2026-09-25');
    expect(dayKeyIn(reset - 1, 'America/Los_Angeles')).toBe('2026-09-24');
  });
});

describe('metered credits', () => {
  const quota: QuotaModel = {
    kind: 'metered_credits',
    currency: 'USD',
    rateCard: { 'GET /posts': 0.005 },
    dedupWindowHours: 24,
    spendCapRequired: true,
  };

  it('requires a spend cap, dedups re-reads within the UTC day and projects spend', async () => {
    const c = clock(Date.UTC(2026, 8, 15, 0, 0, 0)); // mid-month
    const { limiter } = limiterAt(c);
    expect(
      (await reserveErr(limiter.handle({ connectionId: conn, quota, lane: 'delta' }), 'GET /posts'))
        .code,
    ).toBe('VALIDATION');
    const h = limiter.handle({
      connectionId: conn,
      quota,
      lane: 'delta',
      spendCap: { monthlyCapUnits: 10, alertThresholdFraction: 0.8 },
    });
    const first = await reserveOk(h, 'GET /posts', 1, 'post:1');
    expect(first.reservedCost).toBe(1);
    await h.settle(first, { httpStatus: 200 });
    const again = await reserveOk(h, 'GET /posts', 1, 'post:1');
    expect(again.reservedCost).toBe(0);
    await h.settle(again, { httpStatus: 200 });
    c.advance(25 * 3600_000);
    const tomorrow = await reserveOk(h, 'GET /posts', 1, 'post:1');
    expect(tomorrow.reservedCost).toBe(1);
    await h.settle(tomorrow, { httpStatus: 200 });
    const snap = await h.snapshot();
    expect(snap.projectedSpend!.spentUnits).toBe(2);
    expect(snap.projectedSpend!.capUnits).toBe(10);
    expect(snap.projectedSpend!.projectedCycleUnits).toBeGreaterThan(2);
  });

  it('pauses background lanes above the alert threshold and everyone at the cap', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const cap = { monthlyCapUnits: 10, alertThresholdFraction: 0.8 };
    const backfill = limiter.handle({ connectionId: conn, quota, lane: 'backfill', spendCap: cap });
    const interactive = limiter.handle({
      connectionId: conn,
      quota,
      lane: 'interactive',
      spendCap: cap,
    });
    for (let i = 0; i < 8; i++)
      await backfill.settle(await reserveOk(backfill, 'GET /posts'), { httpStatus: 200 });
    expect((await reserveErr(backfill, 'GET /posts')).details.reason).toMatch(/80%/);
    await interactive.settle(await reserveOk(interactive, 'GET /posts'), { httpStatus: 200 });
    await interactive.settle(await reserveOk(interactive, 'GET /posts'), { httpStatus: 200 });
    expect((await reserveErr(interactive, 'GET /posts')).code).toBe('QUOTA_EXHAUSTED');
  });
});

describe('snapshot', () => {
  it('reports the lane being throttled and open circuits', async () => {
    const c = clock();
    const { limiter } = limiterAt(c);
    const quota: QuotaModel = { kind: 'fixed_window', windowSeconds: 900, limit: 10 };
    const h = limiter.handle({ connectionId: conn, quota, lane: 'interactive' });
    for (let i = 0; i < 7; i++) await h.settle(await reserveOk(h, 'GET /x'), {});
    for (let i = 0; i < 5; i++) await limiter.breaker.recordFailure(conn, 'GET /x', 503);
    const snap = await h.snapshot();
    expect(snap.throttledFromLane).toBe('backfill');
    expect(snap.circuits['GET /x']?.state).toBe('open');
  });
});
