/**
 * Graph API version-drift monitor (spec §8.1). Two halves:
 *
 *  1. Per response, core compares the `facebook-api-version` header with the pinned version
 *     (manifest.apiVersionHeader) and logs SCHEMA_DRIFT when they differ — the silent-fallback
 *     hazard.
 *  2. Weekly, `checkGraphVersion` works out when the pinned version sunsets. Meta publishes no
 *     machine-readable schedule, so the built-in table (release dates as of September 2026) is
 *     the baseline; an operator can point `feedUrl` at a JSON mirror `{ versions: [{ version,
 *     released, sunset? }] }` kept current from the changelog. A version is assumed to expire
 *     two years after the NEXT version ships (Meta's stated policy) when no explicit sunset is
 *     known. Inside 180 days the caller opens an in-app task.
 */
import { z } from 'zod';

export type GraphVersion = { version: string; released: Date; sunset: Date | null };

/** Release history as of September 2026. Keep newest last. */
export const KNOWN_VERSIONS: GraphVersion[] = [
  { version: 'v18.0', released: new Date('2023-09-12'), sunset: new Date('2025-08-06') },
  { version: 'v19.0', released: new Date('2024-01-23'), sunset: new Date('2026-02-04') },
  { version: 'v20.0', released: new Date('2024-05-21'), sunset: new Date('2026-05-21') },
  { version: 'v21.0', released: new Date('2024-10-02'), sunset: null },
  { version: 'v22.0', released: new Date('2025-01-21'), sunset: null },
  { version: 'v23.0', released: new Date('2025-05-29'), sunset: null },
  { version: 'v24.0', released: new Date('2025-10-14'), sunset: null },
  { version: 'v25.0', released: new Date('2026-02-24'), sunset: null },
  { version: 'v26.0', released: new Date('2026-07-29'), sunset: null },
];

const feedSchema = z.object({
  versions: z.array(
    z.object({
      version: z.string().regex(/^v\d+\.\d+$/),
      released: z.coerce.date(),
      sunset: z.coerce.date().nullable().optional(),
    }),
  ),
});

export const SUNSET_WARNING_DAYS = 180;
const TWO_YEARS_MS = 2 * 365 * 86_400_000;

export type VersionCheck = {
  pinned: string;
  latest: string;
  pinnedReleased: Date | null;
  sunsetAt: Date | null;
  sunsetSource: 'published' | 'estimated' | 'unknown';
  daysUntilSunset: number | null;
  /** `ok` · `plan_upgrade` (inside the warning window) · `urgent` (inside 30 days or already past) · `unknown_version` */
  action: 'ok' | 'plan_upgrade' | 'urgent' | 'unknown_version';
  behind: number;
  summary: string;
};

function versionNumber(v: string): number {
  return Number(v.replace(/^v/, ''));
}

export function evaluateVersions(
  pinned: string,
  versions: GraphVersion[],
  now: Date,
): VersionCheck {
  const sorted = [...versions].sort((a, b) => versionNumber(a.version) - versionNumber(b.version));
  const latest = sorted.at(-1)?.version ?? pinned;
  const idx = sorted.findIndex((v) => v.version === pinned);
  if (idx < 0) {
    return {
      pinned,
      latest,
      pinnedReleased: null,
      sunsetAt: null,
      sunsetSource: 'unknown',
      daysUntilSunset: null,
      action: 'unknown_version',
      behind: 0,
      summary: `${pinned} is not in the known Graph API schedule; update the version table or the feed.`,
    };
  }
  const me = sorted[idx]!;
  const next = sorted[idx + 1];
  let sunsetAt: Date | null = me.sunset;
  let sunsetSource: VersionCheck['sunsetSource'] = me.sunset ? 'published' : 'unknown';
  if (!sunsetAt && next) {
    sunsetAt = new Date(next.released.getTime() + TWO_YEARS_MS);
    sunsetSource = 'estimated';
  }
  const days = sunsetAt ? Math.floor((sunsetAt.getTime() - now.getTime()) / 86_400_000) : null;
  const behind = sorted.length - 1 - idx;
  let action: VersionCheck['action'] = 'ok';
  if (days !== null && days <= 30) action = 'urgent';
  else if (days !== null && days <= SUNSET_WARNING_DAYS) action = 'plan_upgrade';
  const when = sunsetAt
    ? `${sunsetAt.toISOString().slice(0, 10)}${sunsetSource === 'estimated' ? ' (estimated: two years after ' + next!.version + ')' : ''}`
    : 'an unknown date';
  const summary =
    action === 'ok'
      ? `Graph API ${pinned} is ${behind === 0 ? 'the latest version' : `${behind} version${behind > 1 ? 's' : ''} behind ${latest}`}; sunset ${when}.`
      : `Graph API ${pinned} sunsets on ${when} — ${days} day${days === 1 ? '' : 's'} away. Plan the upgrade to ${latest}: review the changelog, update the manifest version, re-run the contract suite and golden fixtures.`;
  return {
    pinned,
    latest,
    pinnedReleased: me.released,
    sunsetAt,
    sunsetSource,
    daysUntilSunset: days,
    action,
    behind,
    summary,
  };
}

/**
 * Merge the optional feed over the built-in table and evaluate. Feed failures never break the
 * check: the built-in table is authoritative until the feed is reachable again.
 */
export async function checkGraphVersion(opts: {
  pinned: string;
  now?: Date;
  feedUrl?: string | null;
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}): Promise<VersionCheck & { feed: 'used' | 'unavailable' | 'none' }> {
  const now = opts.now ?? new Date();
  let versions = KNOWN_VERSIONS;
  let feed: 'used' | 'unavailable' | 'none' = 'none';
  if (opts.feedUrl) {
    try {
      const res = await (opts.fetch ?? ((u: string) => globalThis.fetch(u)))(opts.feedUrl);
      const parsed = feedSchema.safeParse(res.ok ? await res.json() : null);
      if (parsed.success) {
        const byVersion = new Map(KNOWN_VERSIONS.map((v) => [v.version, v]));
        for (const v of parsed.data.versions)
          byVersion.set(v.version, {
            version: v.version,
            released: v.released,
            sunset: v.sunset ?? null,
          });
        versions = [...byVersion.values()];
        feed = 'used';
      } else feed = 'unavailable';
    } catch {
      feed = 'unavailable';
    }
  }
  return { ...evaluateVersions(opts.pinned, versions, now), feed };
}
