import { describe, expect, it } from 'vitest';
import { LANES, LANE_PRIORITY, QUOTA_KINDS, quotaModelSchema, type QuotaModel } from './quota.ts';

const shapes: Record<QuotaModel['kind'], unknown> = {
  fixed_window: {
    kind: 'fixed_window',
    windowSeconds: 900,
    limit: 300,
    perEndpoint: { 'GET /2/users/:id/mentions': 180 },
  },
  rolling_hour: {
    kind: 'rolling_hour',
    limit: 200,
    headerNames: ['x-app-usage', 'x-business-use-case-usage'],
  },
  daily_units: {
    kind: 'daily_units',
    dailyUnits: 10_000,
    resetTimezone: 'America/Los_Angeles',
    unitCosts: {
      'playlistItems.list': 1,
      'comments.insert': 50,
      'search.list': 1,
      'videos.insert': 1,
    },
    cappedEndpoints: { 'search.list': 100, 'videos.insert': 100 },
  },
  metered_credits: {
    kind: 'metered_credits',
    currency: 'USD',
    rateCard: { post_read: 0.005, post_write: 0.015, post_write_with_url: 0.2 },
    cycleCapUnits: 3_000_000,
    dedupWindowHours: 24,
    spendCapRequired: true,
  },
};

describe('quotaModelSchema', () => {
  it.each(QUOTA_KINDS)('discriminates the %s shape', (kind) => {
    const result = quotaModelSchema.safeParse(shapes[kind]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    if (result.success) expect(result.data.kind).toBe(kind);
  });

  it('applies defaults (rolling_hour backoff, daily_units default unit cost)', () => {
    const rolling = quotaModelSchema.parse(shapes.rolling_hour);
    expect(rolling.kind === 'rolling_hour' && rolling.backoffAtFraction).toBe(0.8);
    const daily = quotaModelSchema.parse(shapes.daily_units);
    expect(daily.kind === 'daily_units' && daily.defaultUnitCost).toBe(1);
  });

  it('rejects a metered_credits model without the 24h dedup window or spend cap requirement', () => {
    expect(
      quotaModelSchema.safeParse({ ...(shapes.metered_credits as object), dedupWindowHours: 12 })
        .success,
    ).toBe(false);
    expect(
      quotaModelSchema.safeParse({ ...(shapes.metered_credits as object), spendCapRequired: false })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown kind and a shape with another kind's fields", () => {
    expect(quotaModelSchema.safeParse({ kind: 'unlimited' }).success).toBe(false);
    expect(
      quotaModelSchema.safeParse({ ...(shapes.daily_units as object), kind: 'fixed_window' })
        .success,
    ).toBe(false);
  });
});

describe('lanes', () => {
  it('orders interactive > webhook > delta > backfill', () => {
    const sorted = [...LANES].sort((a, b) => LANE_PRIORITY[a] - LANE_PRIORITY[b]);
    expect(sorted).toEqual(['interactive', 'webhook', 'delta', 'backfill']);
  });
});
