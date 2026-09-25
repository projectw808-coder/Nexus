import { describe, expect, it } from 'vitest';
import type { ConnectorManifest } from '../manifest.ts';
import { simulateQuota } from './quota-simulator.ts';

const manifest: ConnectorManifest = {
  platform: 'YOUTUBE',
  displayName: 'YouTube',
  apiVersion: 'v3',
  docsUrl: 'https://developers.google.com/youtube',
  authKind: 'oauth2',
  scopes: [],
  resources: [
    {
      id: 'yt.comments',
      displayName: 'Comments',
      kinds: ['yt_comment'],
      defaultIntervalSeconds: 300,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
    {
      id: 'yt.search',
      displayName: 'Search',
      kinds: ['yt_video'],
      defaultIntervalSeconds: 3600,
      defaultEnabled: false,
      supportsBackfill: false,
      supportsWebhook: false,
      costPerPage: 100,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta'] },
      warning: 'expensive',
    },
  ],
  capabilities: ['read:comments'],
  quota: {
    kind: 'daily_units',
    dailyUnits: 10_000,
    resetTimezone: 'America/Los_Angeles',
    unitCosts: {},
    defaultUnitCost: 1,
    cappedEndpoints: { 'search.list': 100 },
  },
  webhooks: { supported: false, verification: 'none', resources: [], replayable: false },
  constraints: [],
  tierNotes: 'default quota',
};

describe('quota simulator', () => {
  it('estimates daily cost, utilization and backfill time', () => {
    const r = simulateQuota({
      manifest,
      resources: [{ id: 'yt.comments' }],
      volume: { 'yt.comments': { itemsPerDay: 500, pageSize: 100 } },
      backfillDays: 90,
    });
    expect(r.unit).toBe('units');
    expect(r.capacityPerDay).toBe(10_000);
    expect(r.perResource[0]).toMatchObject({
      pollsPerDay: 288,
      pagesPerDay: 288,
      costPerDay: 288,
      backfillCost: 450,
    });
    expect(r.utilization).toBeCloseTo(0.0288, 3);
    expect(r.backfillDaysEstimate).toBe(1);
    expect(r.fits).toBe(true);
  });

  it('warns when the plan exceeds capacity and when a backfill can never finish', () => {
    const r = simulateQuota({
      manifest,
      resources: [
        { id: 'yt.search', intervalSeconds: 600 },
        { id: 'yt.comments', intervalSeconds: 60 },
      ],
      volume: { 'yt.comments': { itemsPerDay: 1_000_000 } },
    });
    expect(r.utilization).toBeGreaterThan(1);
    expect(r.fits).toBe(false);
    expect(r.backfillDaysEstimate).toBeNull();
    expect(r.warnings.some((w) => w.includes('exceeds'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('never complete'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('expensive'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('search.list'))).toBe(true);
  });

  it('asks for a spend cap on metered platforms and respects a declared tier', () => {
    const metered: ConnectorManifest = {
      ...manifest,
      platform: 'X',
      quota: {
        kind: 'metered_credits',
        currency: 'USD',
        rateCard: {},
        dedupWindowHours: 24,
        spendCapRequired: true,
      },
    };
    const r = simulateQuota({ manifest: metered, resources: [{ id: 'yt.comments' }], volume: {} });
    expect(r.warnings.some((w) => w.includes('spend cap'))).toBe(true);
    const capped = simulateQuota({
      manifest: metered,
      resources: [{ id: 'yt.comments' }],
      volume: {},
      monthlyCapUnits: 3000,
    });
    expect(capped.capacityPerDay).toBe(100);
    const tier = simulateQuota({
      manifest,
      resources: [{ id: 'yt.comments' }],
      volume: {},
      tier: { dailyCapacity: 1_000_000, label: 'raised' },
    });
    expect(tier.capacityPerDay).toBe(1_000_000);
  });
});
