/**
 * UTC-day bucketing, following the `dailyRunActivity` pattern (Phase 9, src/sync/runs.ts):
 * read the rows for the window, bucket them in application code, and return a fixed number of
 * zero-filled buckets so the x axis is the same length whether or not anything happened.
 *
 * There is no rollup table behind any of this. Each Reports source states its own ceiling where
 * it is defined; the shared rule is that these are dashboard queries over recent weeks.
 */

/** The UTC day a timestamp falls in, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of the day `daysAgo` days before `now`. */
export function startOfUtcDay(now: Date, daysAgo = 0): Date {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The last `days` UTC day keys, oldest first, ending with the day `now` falls in. */
export function dayKeys(days: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(startOfUtcDay(now, i)));
  return out;
}

/** Monday-anchored ISO week key (`YYYY-MM-DD` of the Monday) for cohort rows. */
export function isoWeekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const shift = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - shift * 86_400_000);
}

export function weekKeys(weeks: number, now: Date): string[] {
  const thisWeek = isoWeekStart(now);
  const out: string[] = [];
  for (let i = weeks - 1; i >= 0; i--)
    out.push(utcDay(new Date(thisWeek.getTime() - i * 7 * 86_400_000)));
  return out;
}

/** Whole weeks between two Monday-anchored week starts. */
export function weeksBetween(from: Date, to: Date): number {
  return Math.floor((isoWeekStart(to).getTime() - isoWeekStart(from).getTime()) / (7 * 86_400_000));
}

/**
 * A zero-filled `bucket → series → number` grid. Buckets and series are fixed up front so a
 * series that is absent from the data still gets a slot (and therefore a stable colour).
 */
export function zeroGrid(
  buckets: readonly string[],
  seriesKeys: readonly string[],
): Record<string, number>[] {
  return buckets.map(() => Object.fromEntries(seriesKeys.map((k) => [k, 0])));
}
