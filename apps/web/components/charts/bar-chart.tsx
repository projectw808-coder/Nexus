'use client';

/**
 * Bar and stacked bar (§12.4). One component, one `stacked` flag, because the two differ only in
 * how a category's segments are laid out — and both obey the same rules: 4px rounded data-ends
 * anchored to the baseline, a 2px surface gap between adjacent and stacked fills, a per-mark
 * tooltip with a hit target larger than the mark, one y axis, a legend at ≥2 series, direct
 * labels at ≤4, and a table view.
 */
import { useMemo, useState } from 'react';
import {
  CHART_MARKS,
  bandScale,
  barPath,
  createSeriesPalette,
  formatCompact,
  linearScale,
  niceTicks,
  stackCategory,
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
  fillFor,
  useChartId,
  useChartToggles,
  type ChartSeries,
} from './chart-frame';
import { SeriesTable } from './chart-table';
import { shortLabel } from './line-chart';

const W = 640;
const H = 240;

export function BarChart(props: BarChartProps) {
  return <Bars {...props} stacked={false} />;
}

export function StackedBarChart(props: BarChartProps) {
  return <Bars {...props} stacked />;
}

export type BarChartProps = {
  title: string;
  description?: string;
  result: SeriesResult;
  filters?: React.ReactNode;
  footnote?: React.ReactNode;
};

function Bars({
  title,
  description,
  result,
  filters,
  footnote,
  stacked,
}: BarChartProps & { stacked: boolean }) {
  const chartId = useChartId('bar');
  const toggles = useChartToggles();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const palette = useMemo(
    () => createSeriesPalette(result.seriesKeys.map((s) => s.key)),
    [result.seriesKeys],
  );
  const series: ChartSeries[] = result.seriesKeys.map((s) => ({
    ...s,
    slot: palette.colorForSeries(s.key).slot,
  }));
  const visible = series.filter((s) => !hidden.has(s.key));

  const labelled = visible.length > 0 && visible.length <= DIRECT_LABEL_LIMIT;
  const plot = {
    x: CHART_PADDING.left,
    y: CHART_PADDING.top,
    width: W - CHART_PADDING.left - CHART_PADDING.right - (labelled ? LABEL_GUTTER : 0),
    height: H - CHART_PADDING.top - CHART_PADDING.bottom,
  };
  const totals = result.values.map((row) =>
    stacked
      ? visible.reduce((sum, s) => sum + (row[s.key] ?? 0), 0)
      : Math.max(0, ...visible.map((s) => row[s.key] ?? 0)),
  );
  const ticks = niceTicks(0, Math.max(1, ...totals), 4);
  const y = linearScale([0, ticks[ticks.length - 1] ?? 1], [plot.y + plot.height, plot.y]);
  const band = bandScale(Math.max(1, result.buckets.length), [plot.x, plot.x + plot.width], 0.3);
  const baseline = y(0);

  const every = Math.max(1, Math.ceil(result.buckets.length / 8));
  const xLabels = result.buckets
    .map((b, i) => ({ i, label: shortLabel(b.label, result.xKind) }))
    .filter((l) => l.i % every === 0 || l.i === result.buckets.length - 1)
    .map((l) => ({ x: band.center(l.i), label: l.label }));

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
          aria-label={`${title}. ${result.valueLabel} across ${result.buckets.length} ${
            result.xKind === 'day' ? 'days' : 'categories'
          }.`}
          className="block h-auto w-full"
          onMouseLeave={() => setHover(null)}
        >
          <TextureDefs chartId={chartId} slots={series.map((s) => s.slot)} />
          <Axes y={y} ticks={ticks} plot={plot} xLabels={xLabels} yLabel={result.valueLabel} />

          {result.buckets.map((b, i) => {
            const row = result.values[i] ?? {};
            const gap = CHART_MARKS.surfaceGap;
            if (stacked) {
              const { segments } = stackCategory(
                visible.map((s) => s.key),
                (k) => row[k] ?? 0,
              );
              return (
                <g key={b.key} data-chart-category={b.key}>
                  {segments.map((seg) => {
                    if (seg.value <= 0) return null;
                    const s = visible.find((v) => v.key === seg.seriesKey)!;
                    const top = y(seg.to);
                    // The 2px surface gap comes out of the bottom of each fill, so adjacent
                    // stacked blocks never touch.
                    const height = Math.max(1, y(seg.from) - top - (seg.from > 0 ? gap : 0));
                    return (
                      <path
                        key={seg.seriesKey}
                        d={barPath(
                          band.start(i),
                          top,
                          band.width,
                          height,
                          CHART_MARKS.dataEndRadius,
                          seg.isTop,
                        )}
                        fill={fillFor(chartId, s.slot, toggles.patterns)}
                      >
                        <title>{`${b.label} · ${s.label}: ${formatCompact(seg.value)}`}</title>
                      </path>
                    );
                  })}
                </g>
              );
            }
            const inner = bandScale(
              Math.max(1, visible.length),
              [band.start(i), band.start(i) + band.width],
              0,
            );
            return (
              <g key={b.key} data-chart-category={b.key}>
                {visible.map((s, si) => {
                  const v = row[s.key] ?? 0;
                  if (v <= 0) return null;
                  const top = y(v);
                  const width = Math.max(1, inner.width - gap);
                  return (
                    <path
                      key={s.key}
                      d={barPath(inner.start(si) + gap / 2, top, width, baseline - top)}
                      fill={fillFor(chartId, s.slot, toggles.patterns)}
                    >
                      <title>{`${b.label} · ${s.label}: ${formatCompact(v)}`}</title>
                    </path>
                  );
                })}
              </g>
            );
          })}

          {/* ≤4 series are also directly labelled, in the reserved gutter: beside the last
              category that has a value, at the middle of that series' segment for a stack. */}
          <DirectLabels
            chartId={chartId}
            x={plot.x + plot.width + 8}
            patterns={toggles.patterns}
            bounds={{ top: plot.y + 4, bottom: plot.y + plot.height }}
            labels={
              labelled
                ? visible.flatMap((s) => {
                    const i = lastIndexWithValue(result, s.key);
                    if (i < 0) return [];
                    const row = result.values[i] ?? {};
                    if (!stacked) return [{ ...s, y: y(row[s.key] ?? 0) + 3 }];
                    const seg = stackCategory(
                      visible.map((v) => v.key),
                      (k) => row[k] ?? 0,
                    ).segments.find((x) => x.seriesKey === s.key);
                    return [{ ...s, y: y(((seg?.from ?? 0) + (seg?.to ?? 0)) / 2) + 3 }];
                  })
                : []
            }
          />

          <g data-chart-hit-targets>
            {result.buckets.map((b, i) => (
              <rect
                key={b.key}
                data-chart-hit={b.key}
                x={band.start(i) - (band.step - band.width) / 2}
                y={plot.y}
                width={band.step}
                height={plot.height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                tabIndex={-1}
              />
            ))}
          </g>
        </svg>

        {hover !== null ? (
          <ChartTooltip
            at={{ leftPct: (band.center(hover) / W) * 100, topPct: (plot.y / H) * 100 }}
            title={result.buckets[hover]?.label ?? ''}
            rows={visible.map((s) => ({
              label: s.label,
              slot: s.slot,
              value: formatCompact(result.values[hover]?.[s.key] ?? 0),
            }))}
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

function lastIndexWithValue(result: SeriesResult, key: string): number {
  for (let i = result.values.length - 1; i >= 0; i--) {
    if ((result.values[i]?.[key] ?? 0) > 0) return i;
  }
  return -1;
}
