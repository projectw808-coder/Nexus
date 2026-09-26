'use client';

/**
 * Cohort retention (§12.4 dashboard defaults): a **single-hue** heatmap on the sequential ramp,
 * `#cde2fb → #0d366b`. Never a rainbow, never a diverging scale — retention has a floor, not a
 * meaningful midpoint.
 *
 * Cells carry a per-cell tooltip and a `<title>`, the value is printed in the cell as well as
 * encoded by colour, and a cell that has not happened yet is left blank rather than drawn as
 * zero. A legend is not the right instrument for a continuous scale, so this ships a ramp key
 * plus the always-available table view.
 */
import { useState } from 'react';
import { CHART_MARKS, relativeLuminance, sequentialColor, sequentialRamp } from '@nexus/ui';
import type { MatrixResult } from '@nexus/core';
import { ChartCard, ChartTooltip, useChartToggles } from './chart-frame';
import { MatrixTable } from './chart-table';

/** Below this luminance the cell needs light ink. Keeps the printed value legible on dark cells. */
const INK_FLIP = 0.3;

export function CohortHeatmap({
  title,
  description,
  result,
  filters,
  footnote,
}: {
  title: string;
  description?: string;
  result: MatrixResult;
  filters?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const toggles = useChartToggles();
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const key = sequentialRamp(5);

  return (
    <ChartCard
      title={title}
      description={description}
      filters={filters}
      toggles={toggles}
      footnote={footnote}
      table={<MatrixTable result={result} caption={`${title} — table view`} />}
    >
      <div className="relative overflow-x-auto">
        <table
          data-chart-heatmap
          className="w-full border-separate text-[var(--text-xs)]"
          style={{ borderSpacing: CHART_MARKS.surfaceGap }}
        >
          <caption className="sr-only">
            {title}. {result.valueLabel}, one row per cohort.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium text-ink-muted">
                Cohort
              </th>
              {result.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="tnum px-2 py-1 text-center font-medium text-ink-muted"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="whitespace-nowrap px-2 py-1 text-left font-normal text-ink-secondary"
                >
                  {row.label}
                  <span className="ml-1.5 tnum text-ink-muted">({row.size})</span>
                </th>
                {result.columns.map((col, c) => {
                  const v = result.cells[r]?.[c];
                  if (v === null || v === undefined) {
                    return (
                      <td
                        key={col.key}
                        data-chart-cell="empty"
                        className="rounded-[3px] border border-dashed border-hairline"
                      />
                    );
                  }
                  const light = sequentialColor(v);
                  // Dark mode reads the same ramp; only the ink flips, so the encoding survives.
                  const ink = relativeLuminance(light) < INK_FLIP ? '#ffffff' : '#0b0b0b';
                  return (
                    <td
                      key={col.key}
                      data-chart-cell={`${row.key}:${col.key}`}
                      onMouseEnter={() => setHover({ r, c })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ r, c })}
                      tabIndex={0}
                      title={`${row.label} · ${col.label}: ${Math.round(v * 100)}%`}
                      className="tnum rounded-[3px] px-2 py-1.5 text-center"
                      style={
                        toggles.patterns
                          ? {
                              backgroundImage: `repeating-linear-gradient(45deg, ${light} 0 ${
                                1 + Math.round(v * 5)
                              }px, var(--surface-card) ${1 + Math.round(v * 5)}px 6px)`,
                              color: 'var(--ink-primary)',
                              border: '1px solid var(--border-hairline)',
                            }
                          : { background: light, color: ink }
                      }
                    >
                      {Math.round(v * 100)}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {hover ? (
          <ChartTooltip
            at={{ leftPct: 50, topPct: 0 }}
            title={`${result.rows[hover.r]?.label ?? ''} · ${result.columns[hover.c]?.label ?? ''}`}
            rows={[
              {
                label: result.valueLabel,
                value: `${Math.round((result.cells[hover.r]?.[hover.c] ?? 0) * 100)}%`,
              },
              { label: 'Cohort size', value: String(result.rows[hover.r]?.size ?? 0) },
            ]}
          />
        ) : null}
      </div>

      <div data-chart-ramp-key className="flex items-center gap-2 text-[var(--text-xs)]">
        <span className="text-ink-muted">0%</span>
        <span className="flex h-2 flex-1 overflow-hidden rounded-[2px]">
          {key.map((c, i) => (
            <span key={i} className="flex-1" style={{ background: c }} />
          ))}
        </span>
        <span className="text-ink-muted">100%</span>
      </div>
    </ChartCard>
  );
}
