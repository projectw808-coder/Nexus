'use client';

/**
 * Table views. §12.4 requires *every* chart to have one, so the same result object that draws a
 * chart also renders here — one implementation, no chance of the two disagreeing. `WidgetTable`
 * additionally serves the TABLE widget kind on its own.
 */
import type { FunnelResult, MatrixResult, SeriesResult, TableResult } from '@nexus/core';

const CELL = 'px-2 py-1.5 align-middle';
const HEAD =
  'px-2 py-1.5 text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted';

function Shell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="max-h-80 overflow-auto rounded-[var(--radius-control)] border border-hairline">
      <table data-chart-table className="w-full border-collapse text-[var(--text-sm)]">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

const num = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '') || '0';

/** A series result as rows of bucket × series. One measure, so one value column per series. */
export function SeriesTable({ result, caption }: { result: SeriesResult; caption: string }) {
  return (
    <Shell caption={caption}>
      <thead className="sticky top-0 border-b border-hairline bg-card">
        <tr>
          <th scope="col" className={HEAD}>
            {result.xKind === 'day' ? 'Day' : 'Category'}
          </th>
          {result.seriesKeys.map((s) => (
            <th key={s.key} scope="col" className={`${HEAD} text-right`}>
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--border-hairline)]">
        {result.buckets.map((b, i) => (
          <tr key={b.key}>
            <th scope="row" className={`${CELL} text-left font-normal`}>
              {b.label}
            </th>
            {result.seriesKeys.map((s) => {
              const v = result.values[i]?.[s.key];
              return (
                <td key={s.key} className={`${CELL} tnum text-right`}>
                  {v === undefined ? '—' : num(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Shell>
  );
}

export function FunnelTable({ result, caption }: { result: FunnelResult; caption: string }) {
  const first = result.steps[0]?.value ?? 0;
  return (
    <Shell caption={caption}>
      <thead className="border-b border-hairline">
        <tr>
          <th scope="col" className={HEAD}>
            Stage
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            {result.valueLabel}
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            Share of first stage
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--border-hairline)]">
        {result.steps.map((s) => (
          <tr key={s.key}>
            <th scope="row" className={`${CELL} text-left font-normal`}>
              {s.label}
            </th>
            <td className={`${CELL} tnum text-right`}>{s.value}</td>
            <td className={`${CELL} tnum text-right`}>
              {first === 0 ? '—' : `${Math.round((s.value / first) * 100)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </Shell>
  );
}

export function MatrixTable({ result, caption }: { result: MatrixResult; caption: string }) {
  return (
    <Shell caption={caption}>
      <thead className="sticky top-0 border-b border-hairline bg-card">
        <tr>
          <th scope="col" className={HEAD}>
            Cohort
          </th>
          <th scope="col" className={`${HEAD} text-right`}>
            Size
          </th>
          {result.columns.map((c) => (
            <th key={c.key} scope="col" className={`${HEAD} text-right`}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--border-hairline)]">
        {result.rows.map((row, r) => (
          <tr key={row.key}>
            <th scope="row" className={`${CELL} text-left font-normal`}>
              {row.label}
            </th>
            <td className={`${CELL} tnum text-right`}>{row.size}</td>
            {result.columns.map((c, i) => {
              const v = result.cells[r]?.[i];
              return (
                <td key={c.key} className={`${CELL} tnum text-right`}>
                  {v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Shell>
  );
}

/** The TABLE widget kind, and the fallback view for anything else. */
export function WidgetTable({ result, caption }: { result: TableResult; caption: string }) {
  return (
    <Shell caption={caption}>
      <thead className="sticky top-0 border-b border-hairline bg-card">
        <tr>
          {result.columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={`${HEAD} ${c.align === 'right' ? 'text-right' : ''}`}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--border-hairline)]">
        {result.rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, i) => (
              <td
                key={result.columns[i]?.key ?? i}
                className={`${CELL} ${
                  result.columns[i]?.align === 'right' ? 'tnum text-right' : ''
                }`}
              >
                {cell === null ? <span className="text-ink-muted">—</span> : String(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Shell>
  );
}
