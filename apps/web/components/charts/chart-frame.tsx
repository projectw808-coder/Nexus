'use client';

/**
 * The parts every chart in this library shares, so §12.4's rules are implemented once:
 *
 *  - `ChartCard` — the card, the title, the one row of filters above the chart, and the two
 *    always-present controls: the table-view toggle and the "accessible patterns" toggle. The
 *    pattern toggle is a real control, not just a media query: someone with a colour-vision
 *    deficiency in an ordinary browser needs it without their OS forcing high contrast.
 *  - `Axes` — **one** y axis and one x axis. There is no second-axis prop here or anywhere else
 *    in this library; two measures of different scale are two charts.
 *  - `ChartLegend` — rendered for ≥2 series, with a colour chip carrying identity. Label text
 *    never wears the series colour.
 *  - `TextureDefs` — the 45°/135° hatch patterns, always defined, used when patterns are on.
 *
 * Colour: categorical fills are `var(--series-N)`, which tokens.css redefines for dark mode, so
 * dark is a *selected* palette rather than an automatic inversion. Interpolated ramps (funnel,
 * heatmap) cannot be a CSS variable, so they ship both steps and swap with the same media-query
 * pattern the design system uses — see `.chart-ramp` in globals.css.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  CHART_MARKS,
  CHART_PADDING,
  formatCompact,
  hatchPath,
  textureForSlot,
  texturePatternId,
  type Scale,
} from '@nexus/ui';

export type ChartSeries = { key: string; label: string; slot: number };

/** The CSS variable holding a slot's colour in the current mode. */
export function seriesVar(slot: number): string {
  return `var(--series-${slot + 1})`;
}

/** ≤4 series are directly labelled as well as legended, so identity is never colour-alone. */
export const DIRECT_LABEL_LIMIT = 4;

/** Width reserved to the right of the plot for the direct labels, so they never overlap a mark. */
export const LABEL_GUTTER = 72;

const LABEL_LINE_HEIGHT = 11;

/**
 * Push labels apart so two series whose last values are close do not print on top of each other.
 * A greedy downward sweep from the top, then a corrective sweep up off the bottom edge: cheap,
 * deterministic, and good enough for the four labels this is ever asked to place.
 */
export function deCollideLabels<T extends { y: number }>(
  items: readonly T[],
  bounds: { top: number; bottom: number },
): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  let cursor = bounds.top;
  const down = sorted.map((item) => {
    const y = Math.max(item.y, cursor);
    cursor = y + LABEL_LINE_HEIGHT;
    return { ...item, y };
  });
  let floor = bounds.bottom;
  for (let i = down.length - 1; i >= 0; i--) {
    down[i] = { ...down[i]!, y: Math.min(down[i]!.y, floor) };
    floor = down[i]!.y - LABEL_LINE_HEIGHT;
  }
  return down;
}

/**
 * Direct labels in the right-hand gutter: a colour chip carries identity, the text stays in muted
 * ink (§12.4 "Text never wears a series colour"). Rendered only for ≤4 series.
 */
export function DirectLabels({
  chartId,
  x,
  patterns,
  labels,
  bounds,
}: {
  chartId: string;
  /** Left edge of the gutter. */
  x: number;
  patterns: boolean;
  labels: readonly { key: string; label: string; slot: number; y: number }[];
  bounds: { top: number; bottom: number };
}) {
  if (labels.length === 0 || labels.length > DIRECT_LABEL_LIMIT) return null;
  return (
    <g data-chart-direct-labels>
      {deCollideLabels(labels, bounds).map((l) => (
        <g key={l.key} data-chart-direct-label={l.key}>
          <rect
            aria-hidden
            x={x}
            y={l.y - 5}
            width={6}
            height={6}
            rx={1}
            fill={fillFor(chartId, l.slot, patterns)}
            stroke={seriesVar(l.slot)}
            strokeWidth={0.5}
          />
          <text x={x + 10} y={l.y} fontSize="10" fill="var(--ink-secondary)">
            {l.label.length > 11 ? `${l.label.slice(0, 10)}…` : l.label}
          </text>
        </g>
      ))}
    </g>
  );
}

export type ChartToggles = {
  showTable: boolean;
  setShowTable: (v: boolean) => void;
  patterns: boolean;
  setPatterns: (v: boolean) => void;
};

/**
 * Table view + texture fills. Patterns turn themselves on under `forced-colors: active` or
 * `prefers-contrast: more`, and the toggle stays available either way.
 */
export function useChartToggles(): ChartToggles {
  const [showTable, setShowTable] = useState(false);
  const [patterns, setPatterns] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const queries = ['(forced-colors: active)', '(prefers-contrast: more)'].map((q) =>
      window.matchMedia(q),
    );
    const sync = () => {
      if (queries.some((q) => q.matches)) setPatterns(true);
    };
    sync();
    for (const q of queries) q.addEventListener('change', sync);
    return () => {
      for (const q of queries) q.removeEventListener('change', sync);
    };
  }, []);
  return { showTable, setShowTable, patterns, setPatterns };
}

function ToggleButton({
  pressed,
  onClick,
  children,
  testId,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={[
        'inline-flex h-7 items-center rounded-[var(--radius-control)] border px-2 text-[var(--text-xs)]',
        'transition-colors duration-[var(--duration-state)]',
        pressed
          ? 'border-strong bg-raised text-ink'
          : 'border-hairline text-ink-secondary hover:bg-raised hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function ChartCard({
  title,
  description,
  filters,
  toggles,
  table,
  footnote,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Filters live in one row above the chart (§12.4). */
  filters?: ReactNode;
  toggles: ChartToggles;
  /** The table view of the same data; shown in place of the chart when toggled. */
  table: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-chart-card
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="truncate text-[var(--text-sm)] font-semibold tracking-tight">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[var(--text-xs)] text-ink-muted">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ToggleButton
            pressed={toggles.patterns}
            onClick={() => toggles.setPatterns(!toggles.patterns)}
            testId="chart-texture-toggle"
          >
            Patterns
          </ToggleButton>
          <ToggleButton
            pressed={toggles.showTable}
            onClick={() => toggles.setShowTable(!toggles.showTable)}
            testId="chart-table-toggle"
          >
            Table
          </ToggleButton>
        </div>
      </header>
      {filters ? (
        <div data-chart-filters className="flex flex-wrap items-center gap-2">
          {filters}
        </div>
      ) : null}
      {toggles.showTable ? table : children}
      {footnote ? <p className="text-[var(--text-xs)] text-ink-muted">{footnote}</p> : null}
    </section>
  );
}

/** Hatch patterns for every slot in use. Always defined; referenced only when patterns are on. */
export function TextureDefs({ chartId, slots }: { chartId: string; slots: readonly number[] }) {
  return (
    <defs>
      {[...new Set(slots)].map((slot) => {
        const t = textureForSlot(slot);
        return (
          <pattern
            key={slot}
            id={texturePatternId(chartId, slot)}
            width={t.gap}
            height={t.gap}
            patternUnits="userSpaceOnUse"
          >
            <rect width={t.gap} height={t.gap} fill="var(--surface-card)" />
            <path
              d={hatchPath(t.angle, t.gap)}
              stroke={seriesVar(slot)}
              strokeWidth={t.width}
              fill="none"
            />
          </pattern>
        );
      })}
    </defs>
  );
}

/** The fill a mark should use: the series colour, or its hatch when patterns are on. */
export function fillFor(chartId: string, slot: number, patterns: boolean): string {
  return patterns ? `url(#${texturePatternId(chartId, slot)})` : seriesVar(slot);
}

/**
 * One y axis and one x axis. `y` is the only value scale this component — or this library —
 * knows about (§12.4: never a dual-axis chart).
 */
export function Axes({
  y,
  ticks,
  plot,
  xLabels,
  yLabel,
  formatY = formatCompact,
}: {
  y: Scale;
  ticks: readonly number[];
  plot: { x: number; y: number; width: number; height: number };
  /** One label per x position, already thinned by the caller. */
  xLabels: readonly { x: number; label: string }[];
  yLabel: string;
  formatY?: (v: number) => string;
}) {
  const baseline = y(Math.max(0, y.domain[0]));
  return (
    <>
      <g data-chart-gridlines aria-hidden>
        {ticks.map((t) => (
          <line
            key={t}
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--chart-grid)"
            strokeWidth={CHART_MARKS.hairline}
          />
        ))}
      </g>
      <g data-chart-axis="y" role="presentation" aria-label={yLabel}>
        <title>{yLabel}</title>
        {ticks.map((t) => (
          <text
            key={t}
            x={plot.x - 6}
            y={y(t) + 3}
            textAnchor="end"
            className="tnum"
            fontSize="10"
            fill="var(--ink-muted)"
          >
            {formatY(t)}
          </text>
        ))}
      </g>
      <g data-chart-axis="x">
        <line
          x1={plot.x}
          x2={plot.x + plot.width}
          y1={baseline}
          y2={baseline}
          stroke="var(--chart-baseline)"
          strokeWidth={CHART_MARKS.hairline}
        />
        {xLabels.map((l) => (
          <text
            key={`${l.x}-${l.label}`}
            x={l.x}
            y={plot.y + plot.height + 14}
            textAnchor="middle"
            fontSize="10"
            fill="var(--ink-muted)"
          >
            {l.label}
          </text>
        ))}
      </g>
    </>
  );
}

/**
 * The legend. Shown for ≥2 series — never for one, where the title already says what the line
 * is. The chip carries the colour; the text stays in normal ink (§12.4 "Chrome").
 */
export function ChartLegend({
  chartId,
  series,
  patterns,
  hidden,
  onToggle,
  foldedInto,
}: {
  chartId: string;
  series: readonly ChartSeries[];
  patterns: boolean;
  hidden: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  foldedInto?: { other: string; members: string[] };
}) {
  if (series.length < 2) return null;
  return (
    <ul data-chart-legend className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => {
        const off = hidden.has(s.key);
        const chip = (
          <>
            <span
              aria-hidden
              data-chart-legend-chip
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{
                background: fillFor(chartId, s.slot, patterns),
                border: `1px solid ${seriesVar(s.slot)}`,
                opacity: off ? 0.3 : 1,
              }}
            />
            <span className={off ? 'text-ink-muted line-through' : 'text-ink-secondary'}>
              {s.label}
            </span>
          </>
        );
        const title =
          foldedInto && s.key === foldedInto.other
            ? `${foldedInto.members.length} smaller series: ${foldedInto.members.join(', ')}`
            : undefined;
        return (
          <li key={s.key} className="text-[var(--text-xs)]">
            {onToggle ? (
              <button
                type="button"
                title={title}
                aria-pressed={!off}
                onClick={() => onToggle(s.key)}
                className="inline-flex items-center gap-1.5"
              >
                {chip}
              </button>
            ) : (
              <span title={title} className="inline-flex items-center gap-1.5">
                {chip}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An HTML tooltip over the plot. Hit targets are the caller's job and are larger than the mark. */
export function ChartTooltip({
  at,
  title,
  rows,
}: {
  at: { leftPct: number; topPct: number };
  title: string;
  rows: { label: string; value: string; slot?: number }[];
}) {
  return (
    <div
      data-chart-tooltip
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-32 -translate-x-1/2 -translate-y-full rounded-[var(--radius-control)] border border-hairline bg-card px-2 py-1.5 text-[var(--text-xs)] shadow-sm"
      style={{ left: `${at.leftPct}%`, top: `${at.topPct}%` }}
    >
      <p className="mb-1 font-medium">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-ink-secondary">
              {r.slot === undefined ? null : (
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-[2px]"
                  style={{ background: seriesVar(r.slot) }}
                />
              )}
              {r.label}
            </span>
            <span className="tnum">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stable per-instance id for pattern/gradient references. */
export function useChartId(prefix: string): string {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return `${prefix}${id}`;
}

export { CHART_PADDING };
