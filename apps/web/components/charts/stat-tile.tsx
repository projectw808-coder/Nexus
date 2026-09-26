'use client';

/**
 * "Messages today" is a stat tile with a delta, not a chart (§12.4 dashboard defaults). It is
 * also the spec's one exception to the interaction rules: a bare number needs no crosshair, no
 * tooltip and no table view of a single cell.
 *
 * The delta is never colour-alone: an arrow glyph and the words "up"/"down" carry it, and the
 * colour used is a *status* colour (§12.3), never a series colour — a delta is a judgement, not
 * a series.
 */
import type { ScalarResult } from '@nexus/core';

function pct(value: number, previous: number): number | null {
  if (previous === 0) return value === 0 ? 0 : null;
  return ((value - previous) / Math.abs(previous)) * 100;
}

export function StatTile({
  title,
  description,
  result,
  comparisonLabel = 'vs. the previous period',
}: {
  title: string;
  description?: string;
  result: ScalarResult;
  comparisonLabel?: string;
}) {
  const previous = result.previous;
  const change = previous === null ? null : pct(result.value, previous);
  const direction =
    previous === null || result.value === previous
      ? 'flat'
      : result.value > previous
        ? 'up'
        : 'down';
  const tone =
    direction === 'flat' ? 'text-ink-muted' : direction === 'up' ? 'text-good' : 'text-serious';
  const glyph = direction === 'flat' ? '→' : direction === 'up' ? '↑' : '↓';

  return (
    <section
      data-chart-card
      data-stat-tile
      className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <h3 className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {/* Proportional figures for a hero number (§12.3): no `tnum` here. */}
      <p className="text-[var(--text-2xl)] font-semibold leading-tight tracking-tight">
        {result.value.toLocaleString('en-US')}
        {result.unit ? (
          <span className="ml-1 text-[var(--text-sm)] font-normal text-ink-muted">
            {result.unit}
          </span>
        ) : null}
      </p>
      {previous === null ? (
        <p className="text-[var(--text-xs)] text-ink-muted">{description ?? result.label}</p>
      ) : (
        <p data-stat-delta className={`text-[var(--text-xs)] ${tone}`}>
          <span aria-hidden className="mr-1">
            {glyph}
          </span>
          <span>
            {direction === 'flat'
              ? 'No change'
              : `${direction === 'up' ? 'Up' : 'Down'} ${
                  change === null ? '' : `${Math.abs(Math.round(change))}% `
                }`.trim()}
          </span>{' '}
          <span className="text-ink-muted">
            {comparisonLabel} ({previous.toLocaleString('en-US')})
          </span>
        </p>
      )}
    </section>
  );
}
