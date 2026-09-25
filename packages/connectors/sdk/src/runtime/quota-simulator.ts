/**
 * Quota simulator (spec §7.3): given the resources a user is about to enable and their volume
 * figures, estimate daily consumption against the connector's quota model and the customer's
 * declared tier, and warn BEFORE anything is enabled.
 */
import type { ConnectorManifest, ResourceDescriptor } from '../manifest.ts';
import type { QuotaModel } from '../quota.ts';

export type SimulationInput = {
  manifest: ConnectorManifest;
  /** Resources to enable, with the poll interval the user chose (defaults to the descriptor's). */
  resources: { id: string; intervalSeconds?: number }[];
  /** Expected new items per day per resource (followers, comments…); missing = 0. */
  volume: Record<string, { itemsPerDay: number; pageSize?: number }>;
  /** Overrides the manifest's capacity when the customer's tier differs (YouTube raised quota, X plan). */
  tier?: { dailyCapacity?: number; label?: string };
  /** Spend cap for `metered_credits` connectors, in rate-card units per month. */
  monthlyCapUnits?: number;
  backfillDays?: number;
};

export type ResourceEstimate = {
  id: string;
  displayName: string;
  intervalSeconds: number;
  pollsPerDay: number;
  pagesPerDay: number;
  costPerDay: number;
  /** One-off cost of the initial backfill window. */
  backfillCost: number;
};

export type SimulationResult = {
  unit: 'calls' | 'units' | 'credits';
  capacityPerDay: number;
  perResource: ResourceEstimate[];
  totalPerDay: number;
  utilization: number;
  /** Days the initial backfill needs if it may only use the headroom left after daily syncing. */
  backfillDaysEstimate: number | null;
  warnings: string[];
  fits: boolean;
};

const DEFAULT_PAGE_SIZE = 100;

export function dailyCapacityOf(
  quota: QuotaModel,
  opts: { tierCapacity?: number; monthlyCapUnits?: number },
): number {
  if (opts.tierCapacity !== undefined) return opts.tierCapacity;
  switch (quota.kind) {
    case 'fixed_window':
      return Math.floor(quota.limit * (86_400 / quota.windowSeconds));
    case 'rolling_hour':
      return quota.limit * 24;
    case 'daily_units':
      return quota.dailyUnits;
    case 'metered_credits':
      return opts.monthlyCapUnits !== undefined
        ? opts.monthlyCapUnits / 30
        : Number.POSITIVE_INFINITY;
  }
}

function unitOf(quota: QuotaModel): SimulationResult['unit'] {
  return quota.kind === 'daily_units'
    ? 'units'
    : quota.kind === 'metered_credits'
      ? 'credits'
      : 'calls';
}

export function simulateQuota(input: SimulationInput): SimulationResult {
  const { manifest } = input;
  const byId = new Map<string, ResourceDescriptor>(manifest.resources.map((r) => [r.id, r]));
  const capacityPerDay = dailyCapacityOf(manifest.quota, {
    tierCapacity: input.tier?.dailyCapacity,
    monthlyCapUnits: input.monthlyCapUnits,
  });
  const backfillDays = input.backfillDays ?? 90;
  const warnings: string[] = [];
  const perResource: ResourceEstimate[] = [];

  for (const sel of input.resources) {
    const r = byId.get(sel.id);
    if (!r) {
      warnings.push(`Unknown resource "${sel.id}" ignored.`);
      continue;
    }
    const intervalSeconds = sel.intervalSeconds ?? r.defaultIntervalSeconds;
    const vol = input.volume[r.id] ?? { itemsPerDay: 0 };
    const pageSize = vol.pageSize ?? DEFAULT_PAGE_SIZE;
    const pollsPerDay = Math.ceil(86_400 / intervalSeconds);
    // Every poll costs at least one page; busy resources need more pages per poll.
    const pagesPerDay = Math.max(pollsPerDay, Math.ceil(vol.itemsPerDay / pageSize));
    const costPerDay = pagesPerDay * r.costPerPage;
    const backfillCost = r.supportsBackfill
      ? Math.ceil((vol.itemsPerDay * backfillDays) / pageSize) * r.costPerPage
      : 0;
    perResource.push({
      id: r.id,
      displayName: r.displayName,
      intervalSeconds,
      pollsPerDay,
      pagesPerDay,
      costPerDay,
      backfillCost,
    });
    if (r.warning) warnings.push(`${r.displayName}: ${r.warning}`);
  }

  const totalPerDay = perResource.reduce((s, r) => s + r.costPerDay, 0);
  const utilization =
    capacityPerDay === Number.POSITIVE_INFINITY ? 0 : totalPerDay / capacityPerDay;
  const headroom = capacityPerDay - totalPerDay;
  const totalBackfill = perResource.reduce((s, r) => s + r.backfillCost, 0);
  const backfillDaysEstimate =
    totalBackfill === 0 ? 0 : headroom <= 0 ? null : Math.ceil(totalBackfill / headroom);

  if (manifest.quota.kind === 'metered_credits' && input.monthlyCapUnits === undefined) {
    warnings.push(
      'This platform bills per use. Set a monthly spend cap before enabling resources.',
    );
  }
  if (utilization >= 1) {
    warnings.push(
      `Estimated ${fmt(totalPerDay)} ${unitOf(manifest.quota)}/day exceeds the ${fmt(capacityPerDay)}/day capacity of ${input.tier?.label ?? 'this tier'}. Syncing will be throttled; lengthen poll intervals or disable a resource.`,
    );
  } else if (utilization >= 0.8) {
    warnings.push(
      `Estimated ${fmt(totalPerDay)} ${unitOf(manifest.quota)}/day is ${Math.round(utilization * 100)}% of capacity — little headroom for backfill or bursts.`,
    );
  }
  if (backfillDaysEstimate === null) {
    warnings.push(
      'The initial backfill can never complete at this volume: the daily sync already uses the whole budget.',
    );
  } else if (backfillDaysEstimate > 7) {
    warnings.push(
      `The initial ${backfillDays}-day backfill will take about ${backfillDaysEstimate} days at the remaining budget.`,
    );
  }
  if (manifest.quota.kind === 'daily_units') {
    for (const [endpoint, cap] of Object.entries(manifest.quota.cappedEndpoints)) {
      warnings.push(`${endpoint} is limited to ${cap} calls/day regardless of remaining units.`);
    }
  }

  return {
    unit: unitOf(manifest.quota),
    capacityPerDay,
    perResource,
    totalPerDay,
    utilization,
    backfillDaysEstimate,
    warnings,
    fits: utilization < 1 && backfillDaysEstimate !== null,
  };
}

function fmt(n: number): string {
  return n === Number.POSITIVE_INFINITY ? '∞' : Math.round(n).toLocaleString('en-US');
}
