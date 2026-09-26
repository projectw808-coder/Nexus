/**
 * §12.4's colour rules as executable code. `tokens.ts` holds the literal values (and the CSS
 * variables mirror them); this module holds the *binding* logic that the charts depend on:
 *
 *  - Categorical colour is bound to a **series key**, never to the series' rank in whatever
 *    subset happens to be visible. A palette is created once per chart from the full, unfiltered
 *    set of series keys, hands out slots 1…8 in that fixed order, and memoises the assignment —
 *    so hiding a series and showing it again, or re-rendering with a different visible subset,
 *    can never repaint the survivors.
 *  - A key the palette never saw declared still gets a content-derived slot (hash of the key,
 *    linear-probed to the first free slot) rather than an arrival-order one, and that too is
 *    memoised.
 *  - A 9th distinct series is never a generated hue: once the palette is out of own slots the
 *    tail folds into a single "Other" bucket that owns slot 8.
 *
 * Pure: no I/O, no React, no DOM. Every rule here has a test in chart-palette.test.ts.
 */
import { CHART_CHROME, DIVERGING, MAX_SERIES, SEQUENTIAL, SERIES, type Mode } from './tokens.ts';

/** One series' colour in both modes. Dark is a *selected* step, never an automatic inversion. */
export type SeriesColor = {
  /** 0-based index into `SERIES[mode]`; 0 is spec series 1 (blue). */
  readonly slot: number;
  readonly light: string;
  readonly dark: string;
  /** True when this key was folded into the "Other" bucket. */
  readonly isOther: boolean;
};

/** The label the folded tail carries. Never a generated hue (§12.4). */
export const OTHER_SERIES_KEY = 'Other';

/**
 * How many keys may keep a slot of their own before the tail folds. Folding has to leave room
 * for "Other" itself, so 8 keys fit exactly and 9+ keep the first 7 and fold the rest.
 */
export const OWN_SLOT_LIMIT = MAX_SERIES - 1;

/** Slot the "Other" bucket owns when folding happens (spec series 8, red). */
export const OTHER_SLOT = MAX_SERIES - 1;

/** Everything a chart needs from §12.4's colour section, in one import. */
export const CHART_PALETTE = {
  series: SERIES,
  sequential: SEQUENTIAL,
  diverging: DIVERGING,
  chrome: CHART_CHROME,
  maxSeries: MAX_SERIES,
} as const;

export function seriesColorAt(slot: number): SeriesColor {
  const i = Math.max(0, Math.min(MAX_SERIES - 1, Math.trunc(slot)));
  return { slot: i, light: SERIES.light[i]!, dark: SERIES.dark[i]!, isOther: i === OTHER_SLOT };
}

/**
 * Fold a series-key list to at most `MAX_SERIES` buckets. ≤8 keys are returned untouched; 9+
 * keep the first `OWN_SLOT_LIMIT` and everything after collapses into one "Other" bucket.
 */
export function foldSeriesKeys(keys: readonly string[]): {
  keys: string[];
  folded: string[];
  didFold: boolean;
} {
  const seen: string[] = [];
  for (const k of keys) if (!seen.includes(k)) seen.push(k);
  if (seen.length <= MAX_SERIES) return { keys: seen, folded: [], didFold: false };
  const kept = seen.slice(0, OWN_SLOT_LIMIT);
  const folded = seen.slice(OWN_SLOT_LIMIT).filter((k) => k !== OTHER_SERIES_KEY);
  return { keys: [...kept, OTHER_SERIES_KEY], folded, didFold: true };
}

/** FNV-1a over the key's code units. Stable across processes: no `Math.random`, no ordering. */
export function hashSeriesKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type SeriesPalette = {
  /** Memoised colour for a series key. Stable for the palette's whole lifetime. */
  colorForSeries(key: string): SeriesColor;
  /** The key a value should be *drawn and labelled* as — itself, or "Other" once folded. */
  bucketFor(key: string): string;
  /** Every key that owns a slot, in slot order (includes "Other" when folding happened). */
  declaredKeys(): readonly string[];
  didFold(): boolean;
  /** Keys the fold swept into "Other" (for the legend's tooltip and the table view). */
  foldedKeys(): readonly string[];
};

/**
 * One palette per chart, created from the **complete** series key set — not the visible subset.
 * Slots go out in the order the keys are declared (§12.4 "assigned in this fixed order"), and the
 * assignment is memoised so it survives any later filtering (§12.4 "colour follows the entity").
 */
export function createSeriesPalette(declared: readonly string[] = []): SeriesPalette {
  const fold = foldSeriesKeys(declared);
  const bySlot = new Map<number, string>();
  const memo = new Map<string, SeriesColor>();

  const take = (key: string, slot: number): SeriesColor => {
    const color = seriesColorAt(slot);
    bySlot.set(slot, key);
    memo.set(key, color);
    return color;
  };

  fold.keys.forEach((key, i) => {
    take(key, key === OTHER_SERIES_KEY && fold.didFold ? OTHER_SLOT : i);
  });
  const foldedSet = new Set(fold.folded);

  const bucketFor = (key: string): string =>
    foldedSet.has(key) || (fold.didFold && !memo.has(key)) ? OTHER_SERIES_KEY : key;

  return {
    colorForSeries(key) {
      const bucket = bucketFor(key);
      const hit = memo.get(bucket);
      if (hit) return hit;
      // Undeclared key: derive the slot from the key itself, then linear-probe to the first
      // free slot. Never the arrival index, so two charts over the same entity agree.
      const start = hashSeriesKey(bucket) % MAX_SERIES;
      for (let step = 0; step < MAX_SERIES; step++) {
        const slot = (start + step) % MAX_SERIES;
        if (!bySlot.has(slot)) return take(bucket, slot);
      }
      // Out of slots entirely: fold, and make sure "Other" owns its slot.
      const other = memo.get(OTHER_SERIES_KEY) ?? take(OTHER_SERIES_KEY, OTHER_SLOT);
      foldedSet.add(key);
      memo.set(key, other);
      return other;
    },
    bucketFor,
    declaredKeys: () => fold.keys,
    didFold: () => fold.didFold || foldedSet.size > 0,
    foldedKeys: () => [...foldedSet],
  };
}

// ── continuous scales ─────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** sRGB interpolation between two stops. `t` is clamped to [0, 1]. */
export function mixHex(from: string, to: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}

/** WCAG relative luminance — used by the tests that police the funnel's ramp bounds. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Sequential: one hue, light→dark, through exactly the two stops §12.4 names. The spec gives a
 * single ramp and no dark counterpart, so both modes use it verbatim rather than inventing a
 * second one — the cohort heatmap flips its *ink* on dark cells instead.
 */
export function sequentialColor(t: number): string {
  return mixHex(SEQUENTIAL.start, SEQUENTIAL.end, t);
}

/** `n` evenly spaced steps of the sequential ramp, light→dark. */
export function sequentialRamp(n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [sequentialColor(1)];
  return Array.from({ length: n }, (_, i) => sequentialColor(i / (n - 1)));
}

/**
 * Diverging: blue ↔ red with a neutral gray midpoint. `t` ∈ [-1, 1]; 0 is exactly the neutral
 * step, never a hue. Nothing here can produce a rainbow: each half is a two-stop mix.
 */
export function divergingColor(t: number, mode: Mode): string {
  const { low, mid, high } = DIVERGING[mode];
  const k = Math.max(-1, Math.min(1, t));
  if (k === 0) return mid;
  return k < 0 ? mixHex(mid, low, -k) : mixHex(mid, high, k);
}

/**
 * The funnel's ordinal ramp. Light starts at `#86b6ef` (never lighter) and darkens to the
 * sequential end; dark starts at `#184f95` (never darker) and lightens to the sequential start.
 */
export function funnelRamp(n: number, mode: Mode): string[] {
  if (n <= 0) return [];
  const from = SEQUENTIAL.funnelStart[mode];
  const to = mode === 'light' ? SEQUENTIAL.end : SEQUENTIAL.start;
  if (n === 1) return [from];
  return Array.from({ length: n }, (_, i) => mixHex(from, to, i / (n - 1)));
}

// ── texture fills (forced-colors, print, and the manual accessibility toggle) ──

/**
 * A 45°/135° line hatch per slot, so identity survives without colour at all. Only the two
 * angles §12.4 names are used; spacing and stroke width separate the eight slots.
 */
export type SeriesTexture = { angle: 45 | 135; gap: number; width: number };

const TEXTURE_STEPS: readonly SeriesTexture[] = [
  { angle: 45, gap: 6, width: 2 },
  { angle: 135, gap: 6, width: 2 },
  { angle: 45, gap: 4, width: 1 },
  { angle: 135, gap: 4, width: 1 },
  { angle: 45, gap: 9, width: 3 },
  { angle: 135, gap: 9, width: 3 },
  { angle: 45, gap: 3, width: 1 },
  { angle: 135, gap: 3, width: 1 },
];

export function textureForSlot(slot: number): SeriesTexture {
  return TEXTURE_STEPS[Math.max(0, Math.min(MAX_SERIES - 1, Math.trunc(slot)))]!;
}

/** Stable DOM id for a slot's hatch pattern, scoped to one chart instance. */
export function texturePatternId(chartId: string, slot: number): string {
  return `${chartId}-hatch-${slot}`;
}
