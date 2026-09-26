'use client';

/**
 * Line chart (§12.4): 2px strokes, ≥8px markers, crosshair + tooltip, a legend at ≥2 series and
 * direct labels at ≤4, one y axis, and a table view.
 *
 * Note the prop list: there is a `valueLabel`, singular. A second measure has nowhere to go —
 * that is the point (§12.4 "One y-axis. Never a dual-axis chart."). Callers that need two scales
 * render two `<LineChart>`s.
 */
import { useMemo, useState } from 'react';
import {
  CHART_MARKS,
  createSeriesPalette,
  linePath,
  linearScale,
  niceTicks,
  formatCompact,
} from '@nexus/ui';
import type { SeriesResult } from '@nexus/core';
import {
  Axes,
  CHART_PADDING,
  ChartCard,
  ChartLegend,
  ChartTooltip,
  DIRECT_LABEL_LIMIT,
  DirectLabels,
  LABEL_GUTTER,
  TextureDefs,
  seriesVar,
  useChartId,
  useChartToggles,
  type ChartSeries,
} from './chart-frame';
import { SeriesTable } from './chart-table';

const W = 640;
const H = 240;

export function LineChart({
  title,
  description,
  result,
  filters,
  footnote,
}: {
  title: string;
  description?: string;
  result: SeriesResult;
  filters?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const chartId = useChartId('line');
  const toggles = useChartToggles();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  // One palette per chart, built from the COMPLETE series set. Hiding a series below cannot
  // repaint the rest, because nothing here ever looks at a visible index.
  const palette = useMemo(
    () => createSeriesPalette(result.seriesKeys.map((s) => s.key)),
    [result.seriesKeys],
  );
  const series: ChartSeries[] = result.seriesKeys.map((s) => ({
    ...s,
    slot: palette.colorForSeries(s.key).slot,
  }));
  const visible = series.filter((s) => !hidden.has(s.key));

  // The gutter is reserved whenever direct labels can appear, so the plot never has to share
  // space with them and the last x tick is never clipped.
  const labelled = visible.length > 0 && visible.length <= DIRECT_LABEL_LIMIT;
  const plot = {
    x: CHART_PADDING.left,
    y: CHART_PADDING.top,
    width: W - CHART_PADDING.left - CHART_PADDING.right - (labelled ? LABEL_GUTTER : 0),
    height: H - CHART_PADDING.top - CHART_PADDING.bottom,
  };
  const all = result.values.flatMap((row) => series.map((s) => row[s.key]).filter(isNumber));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(1, ...all), 4);
  const y = linearScale(
    [ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1],
    [plot.y + plot.height, plot.y],
  );
  const n = Math.max(1, result.buckets.length);
  const x = (i: number) =>
    n === 1 ? plot.x + plot.width / 2 : plot.x + (i / (n - 1)) * plot.width;

  // Every x label would collide; thin to at most six, always keeping the ends.
  const every = Math.max(1, Math.ceil(result.buckets.length / 6));
  const xLabels = result.buckets
    .map((b, i) => ({ i, label: shortLabel(b.label, result.xKind) }))
    .filter((l) => l.i % every === 0 || l.i === result.buckets.length - 1)
    .map((l) => ({ x: x(l.i), label: l.label }));

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hoverRows =
    hover === null
      ? []
      : visible
          .map((s) => ({
            label: s.label,
            slot: s.slot,
            value: result.values[hover]?.[s.key],
          }))
          .filter((r): r is { label: string; slot: number; value: number } => isNumber(r.value))
          .map((r) => ({ label: r.label, slot: r.slot, value: formatCompact(r.value) }));

  return (
    <ChartCard
      title={title}
      description={description}
      filters={filters}
      toggles={toggles}
      footnote={footnote}
      table={<SeriesTable result={result} caption={`${title} — table view`} />}
    >
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${title}. ${result.valueLabel} over ${result.buckets.length} ${
            result.xKind === 'day' ? 'days' : 'categories'
          }.`}
          className="block h-auto w-full"
          onMouseLeave={() => setHover(null)}
        >
          <TextureDefs chartId={chartId} slots={series.map((s) => s.slot)} />
          <Axes y={y} ticks={ticks} plot={plot} xLabels={xLabels} yLabel={result.valueLabel} />

          {hover === null ? null : (
            <line
              data-chart-crosshair
              x1={x(hover)}
              x2={x(hover)}
              y1={plot.y}
              y2={plot.y + plot.height}
              stroke="var(--chart-baseline)"
              strokeWidth={CHART_MARKS.hairline}
              strokeDasharray="3 3"
            />
          )}

          {visible.map((s) => {
            // A bucket with no observation is a *gap*, not a zero: split the path there rather
            // than drawing a line through a value nobody measured.
            const runs: { i: number; v: number }[][] = [];
            let run: { i: number; v: number }[] = [];
            result.values.forEach((row, i) => {
              const v = row[s.key];
              if (isNumber(v)) run.push({ i, v });
              else if (run.length > 0) {
                runs.push(run);
                run = [];
              }
            });
            if (run.length > 0) runs.push(run);
            const dashed = toggles.patterns ? (s.slot % 2 === 0 ? '6 3' : '2 3') : undefined;
            return (
              <g key={s.key} data-chart-series={s.key}>
                {runs.map((r, ri) => (
                  <path
                    key={ri}
                    d={linePath(r.map((p) => ({ x: x(p.i), y: y(p.v) })))}
                    fill="none"
                    stroke={seriesVar(s.slot)}
                    strokeWidth={CHART_MARKS.lineWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    {...(dashed ? { strokeDasharray: dashed } : {})}
                  />
                ))}
                {runs.flat().map((p) => (
                  <circle
                    key={p.i}
                    cx={x(p.i)}
                    cy={y(p.v)}
                    r={CHART_MARKS.markerSize / 2}
                    fill={seriesVar(s.slot)}
                    // A 2px surface ring keeps overlapping markers readable.
                    stroke="var(--surface-card)"
                    strokeWidth={CHART_MARKS.surfaceRing}
                  >
                    <title>{`${result.buckets[p.i]?.label ?? ''} · ${s.label}: ${formatCompact(p.v)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}

          {/* ≤4 series are also directly labelled, in the reserved gutter. */}
          <DirectLabels
            chartId={chartId}
            x={plot.x + plot.width + 8}
            patterns={toggles.patterns}
            bounds={{ top: plot.y + 4, bottom: plot.y + plot.height }}
            labels={
              labelled
                ? visible.flatMap((s) => {
                    const last = lastDefined(result, s.key);
                    return last === null ? [] : [{ ...s, y: y(last) + 3 }];
                  })
                : []
            }
          />

          {/* Hit targets: a full-height column per bucket, far larger than any mark. */}
          <g data-chart-hit-targets>
            {result.buckets.map((b, i) => (
              <rect
                key={b.key}
                data-chart-hit={b.key}
                x={x(i) - plot.width / (2 * n)}
                y={plot.y}
                width={plot.width / n}
                height={plot.height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                tabIndex={-1}
              />
            ))}
          </g>
        </svg>

        {hover !== null && hoverRows.length > 0 ? (
          <ChartTooltip
            at={{ leftPct: (x(hover) / W) * 100, topPct: (plot.y / H) * 100 }}
            title={result.buckets[hover]?.label ?? ''}
            rows={hoverRows}
          />
        ) : null}
      </div>

      <ChartLegend
        chartId={chartId}
        series={series}
        patterns={toggles.patterns}
        hidden={hidden}
        onToggle={toggle}
        {...(result.foldedInto ? { foldedInto: result.foldedInto } : {})}
      />
    </ChartCard>
  );
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The series' last observed value, or null when it was never observed. */
function lastDefined(result: SeriesResult, key: string): number | null {
  for (let i = result.values.length - 1; i >= 0; i--) {
    const v = result.values[i]?.[key];
    if (isNumber(v)) return v;
  }
  return null;
}

export function shortLabel(label: string, xKind: 'day' | 'category'): string {
  if (xKind !== 'day') return label.length > 12 ? `${label.slice(0, 11)}…` : label;
  return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label.slice(5) : label;
}
