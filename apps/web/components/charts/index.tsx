'use client';

/**
 * The chart primitive library's public surface, plus `WidgetChart`: the one place that maps a
 * `WidgetKind` to the component that draws it. The mapping is total over the fixed catalogue —
 * add a kind to the schema and this switch stops compiling, which is the intent.
 */
import type { WidgetKind, WidgetResult } from '@nexus/core';
import { BarChart, StackedBarChart } from './bar-chart';
import { CohortHeatmap } from './cohort-heatmap';
import { FunnelChart } from './funnel-chart';
import { LineChart } from './line-chart';
import { StatTile } from './stat-tile';
import { WidgetTable } from './chart-table';
import { ChartCard, useChartToggles } from './chart-frame';

export { BarChart, StackedBarChart } from './bar-chart';
export { CohortHeatmap } from './cohort-heatmap';
export { FunnelChart } from './funnel-chart';
export { LineChart } from './line-chart';
export { StatTile } from './stat-tile';
export { FunnelTable, MatrixTable, SeriesTable, WidgetTable } from './chart-table';
export {
  Axes,
  ChartCard,
  ChartLegend,
  ChartTooltip,
  DIRECT_LABEL_LIMIT,
  TextureDefs,
  fillFor,
  seriesVar,
  useChartId,
  useChartToggles,
} from './chart-frame';
export type { ChartSeries, ChartToggles } from './chart-frame';

/** A widget whose stored kind and executed result do not line up: say so, do not guess. */
function Mismatch({ title, kind, shape }: { title: string; kind: WidgetKind; shape: string }) {
  return (
    <section
      data-chart-card
      className="rounded-[var(--radius-card)] border border-hairline bg-card p-4"
      role="alert"
    >
      <h3 className="text-[var(--text-sm)] font-semibold tracking-tight">{title}</h3>
      <p className="mt-1 text-[var(--text-xs)] text-ink-secondary">
        This widget is saved as a {kind.toLowerCase().replace('_', ' ')} but its query returns{' '}
        {shape} data. Edit the widget to pick a matching data source.
      </p>
    </section>
  );
}

function TableOnly({
  title,
  description,
  result,
}: {
  title: string;
  description?: string;
  result: Extract<WidgetResult, { shape: 'table' }>;
}) {
  const toggles = useChartToggles();
  return (
    <ChartCard
      title={title}
      description={description}
      toggles={toggles}
      table={<WidgetTable result={result} caption={`${title} — table view`} />}
      footnote={
        result.truncated ? 'Showing the first page; narrow the filters to see less.' : undefined
      }
    >
      <WidgetTable result={result} caption={title} />
    </ChartCard>
  );
}

export function WidgetChart({
  kind,
  title,
  description,
  result,
  filters,
  footnote,
}: {
  kind: WidgetKind;
  title: string;
  description?: string;
  result: WidgetResult;
  filters?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const mismatch = <Mismatch title={title} kind={kind} shape={result.shape} />;
  switch (kind) {
    case 'STAT_TILE':
      return result.shape === 'scalar' ? (
        <StatTile title={title} {...(description ? { description } : {})} result={result} />
      ) : (
        mismatch
      );
    case 'LINE':
      return result.shape === 'series' ? (
        <LineChart
          title={title}
          {...(description ? { description } : {})}
          result={result}
          filters={filters}
          footnote={footnote}
        />
      ) : (
        mismatch
      );
    case 'BAR':
      return result.shape === 'series' ? (
        <BarChart
          title={title}
          {...(description ? { description } : {})}
          result={result}
          filters={filters}
          footnote={footnote}
        />
      ) : (
        mismatch
      );
    case 'STACKED_BAR':
      return result.shape === 'series' ? (
        <StackedBarChart
          title={title}
          {...(description ? { description } : {})}
          result={result}
          filters={filters}
          footnote={footnote}
        />
      ) : (
        mismatch
      );
    case 'FUNNEL':
      return result.shape === 'funnel' ? (
        <FunnelChart
          title={title}
          {...(description ? { description } : {})}
          result={result}
          filters={filters}
          footnote={footnote}
        />
      ) : (
        mismatch
      );
    case 'COHORT_HEATMAP':
      return result.shape === 'matrix' ? (
        <CohortHeatmap
          title={title}
          {...(description ? { description } : {})}
          result={result}
          filters={filters}
          footnote={footnote}
        />
      ) : (
        mismatch
      );
    case 'TABLE':
      return result.shape === 'table' ? (
        <TableOnly title={title} {...(description ? { description } : {})} result={result} />
      ) : (
        mismatch
      );
  }
}
