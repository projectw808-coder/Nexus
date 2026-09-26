/**
 * The pure geometry behind the chart primitives: §12.4's mark constants, one linear scale, tick
 * selection, stacking with the 2px surface gap, and the path builders. Kept out of the React
 * layer so the shapes the spec fixes (2px strokes, ≥8px markers, 4px data-ends anchored to the
 * baseline, the 2px gap between stacked fills) are testable without a DOM.
 *
 * There is deliberately no "second axis" concept anywhere in this file — see §12.4's one-y-axis
 * rule, which the chart components enforce by simply not having a prop for it.
 */

/** §12.4 "Marks": thin, and exactly these sizes. */
export const CHART_MARKS = {
  /** Line and area stroke width. */
  lineWidth: 2,
  /** Diameter of a line's point marker — never below 8px. */
  markerSize: 8,
  /** Corner radius of a bar's data-end; the baseline end stays square. */
  dataEndRadius: 4,
  /** Surface-coloured gap between adjacent and stacked fills. */
  surfaceGap: 2,
  /** Surface-coloured ring where marks overlap. */
  surfaceRing: 2,
  /** Gridline and baseline widths — hairline, recessive chrome. */
  hairline: 1,
} as const;

/** Plot padding that leaves room for one y-axis on the left and one x-axis underneath. */
export const CHART_PADDING = { top: 12, right: 12, bottom: 28, left: 44 } as const;

export type Scale = {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
};

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = (value: number): number =>
    span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0);
  return Object.assign(fn, { domain, range });
}

export function bandScale(
  count: number,
  range: readonly [number, number],
  innerPadding = 0.2,
): { step: number; width: number; center(i: number): number; start(i: number): number } {
  const [r0, r1] = range;
  const step = count > 0 ? (r1 - r0) / count : r1 - r0;
  const width = Math.max(1, step * (1 - innerPadding));
  return {
    step,
    width,
    start: (i) => r0 + i * step + (step - width) / 2,
    center: (i) => r0 + i * step + step / 2,
  };
}

/**
 * Human tick values covering [0, max] (or [min, max] when min < 0), at roughly `count` steps.
 * Always includes the baseline so the zero line is real, not implied.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max === lo ? lo + 1 : max;
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step / 2; t += step) {
    out.push(Number(t.toFixed(10)));
  }
  return out;
}

/** The domain a chart should use: [0, nice max] — or [nice min, nice max] when values go negative. */
export function niceDomain(values: readonly number[], count = 4): [number, number] {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const ticks = niceTicks(min, max, count);
  return [ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1];
}

// ── stacking ──────────────────────────────────────────────────────────────────

export type StackSegment = {
  seriesKey: string;
  value: number;
  /** Cumulative value at the segment's bottom / top, in data units. */
  from: number;
  to: number;
  /** True for the top-most non-zero segment: the one that wears the rounded data-end. */
  isTop: boolean;
};

/**
 * Stack one category's values in the palette's declared series order. Zero-valued series are
 * kept (so a tooltip can say "0") but never claim the rounded data-end.
 */
export function stackCategory(
  seriesKeys: readonly string[],
  valueOf: (seriesKey: string) => number,
): { segments: StackSegment[]; total: number } {
  let cursor = 0;
  const segments: StackSegment[] = [];
  for (const seriesKey of seriesKeys) {
    const value = valueOf(seriesKey) || 0;
    segments.push({ seriesKey, value, from: cursor, to: cursor + value, isTop: false });
    cursor += value;
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.value > 0) {
      segments[i] = { ...segments[i]!, isTop: true };
      break;
    }
  }
  return { segments, total: cursor };
}

// ── path builders ─────────────────────────────────────────────────────────────

/**
 * A bar with rounded data-end corners and a square baseline end (§12.4: "4px rounded data-ends
 * anchored to the baseline"). `radius` is clamped so a short bar degrades to a rectangle instead
 * of a lozenge. `rounded: false` draws a plain rect — used for the middle of a stack.
 */
export function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = CHART_MARKS.dataEndRadius,
  rounded = true,
): string {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const r = rounded ? Math.max(0, Math.min(radius, w / 2, h)) : 0;
  if (r === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return [
    `M${x} ${y + r}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}`,
    `h${w - 2 * r}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `v${h - r}`,
    `h${-w}`,
    'Z',
  ].join('');
}

export type Point = { x: number; y: number };

/** A polyline path. No smoothing: a spline would invent values between the samples. */
export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}

/** The same line closed down to the baseline, for an area fill. */
export function areaPath(points: readonly Point[], baselineY: number): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${linePath(points)} L${last.x} ${baselineY} L${first.x} ${baselineY} Z`;
}

/** A 45°/135° hatch tile path for a texture `<pattern>` of side `gap`. */
export function hatchPath(angle: 45 | 135, gap: number): string {
  return angle === 45
    ? `M0 ${gap} L${gap} 0 M${-gap / 2} ${gap / 2} L${gap / 2} ${-gap / 2} M${gap / 2} ${gap * 1.5} L${gap * 1.5} ${gap / 2}`
    : `M0 0 L${gap} ${gap} M${-gap / 2} ${gap / 2} L${gap / 2} ${gap * 1.5} M${gap / 2} ${-gap / 2} L${gap * 1.5} ${gap / 2}`;
}

/** Format a tick or tooltip number compactly without a locale dependency in tests. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return trim(value);
}

function trim(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
