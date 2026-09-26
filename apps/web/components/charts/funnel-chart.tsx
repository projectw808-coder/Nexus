'use client';

/**
 * Funnel (§12.4 dashboard defaults): an **ordinal ramp**, not eight categorical hues — the
 * stages are one ordered thing, so they get one hue that darkens. The ramp starts no lighter
 * than `#86b6ef` on light and no darker than `#184f95` on dark (`funnelRamp` in @nexus/ui
 * enforces and tests those bounds).
 *
 * Both steps ship on every bar and `.chart-ramp` in globals.css swaps them for dark mode, using
 * the same guarded media query as the rest of the design system — a selected palette, not an
 * inversion.
 */
import { useMemo, useState } from 'react';
import { CHART_MARKS, barPath, formatCompact, funnelRamp, linearScale, niceTicks } from '@nexus/ui';
import type { FunnelResult } from '@nexus/core';
import { Axes, CHART_PADDING, ChartCard, ChartTooltip, useChartToggles } from './chart-frame';
import { FunnelTable } from './chart-table';

const W = 640;
const H = 240;

export function FunnelChart({
  title,
  description,
  result,
  filters,
  footnote,
}: {
  title: string;
  description?: string;
  result: FunnelResult;
  filters?: React.ReactNode;
  footnote?: React.ReactNode;
}) {
  const toggles = useChartToggles();
  const [hover, setHover] = useState<number | null>(null);
  const steps = result.steps;
  const ramp = useMemo(
    () => ({ light: funnelRamp(steps.length, 'light'), dark: funnelRamp(steps.length, 'dark') }),
    [steps.length],
  );

  const plot = {
    x: CHART_PADDING.left,
    y: CHART_PADDING.top,
    width: W - CHART_PADDING.left - CHART_PADDING.right,
    height: H - CHART_PADDING.top - CHART_PADDING.bottom,
  };
  const ticks = niceTicks(0, Math.max(1, ...steps.map((s) => s.value)), 4);
  const y = linearScale([0, ticks[ticks.length - 1] ?? 1], [plot.y + plot.height, plot.y]);
  const step = plot.width / Math.max(1, steps.length);
  const width = Math.max(1, step - 8 - CHART_MARKS.surfaceGap);
  const first = steps[0]?.value ?? 0;
  const baseline = y(0);

  return (
    <ChartCard
      title={title}
      description={description}
      filters={filters}
      toggles={toggles}
      footnote={footnote}
      table={<FunnelTable result={result} caption={`${title} — table view`} />}
    >
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${title}. ${result.valueLabel} across ${steps.length} stages.`}
          className="block h-auto w-full"
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            {/* One hatch per stage for the patterns toggle: ordinal, so spacing tightens down
                the funnel rather than switching angle at random. */}
            {steps.map((s, i) => (
              <pattern
                key={s.key}
                id={`funnel-hatch-${i}`}
                width={8}
                height={8}
                patternUnits="userSpaceOnUse"
              >
                <rect width={8} height={8} fill="var(--surface-card)" />
                <path
                  d="M0 8 L8 0 M-4 4 L4 -4 M4 12 L12 4"
                  stroke="var(--seq-end)"
                  strokeWidth={1 + (i / Math.max(1, steps.length - 1)) * 3}
                  fill="none"
                />
              </pattern>
            ))}
          </defs>
          <Axes
            y={y}
            ticks={ticks}
            plot={plot}
            xLabels={steps.map((s, i) => ({
              x: plot.x + i * step + step / 2,
              label: s.label.length > 12 ? `${s.label.slice(0, 11)}…` : s.label,
            }))}
            yLabel={result.valueLabel}
          />
          {steps.map((s, i) => {
            const top = y(s.value);
            return (
              <g key={s.key} data-chart-stage={s.key}>
                <path
                  className="chart-ramp"
                  data-chart-ramp-step={i}
                  d={barPath(plot.x + i * step + (step - width) / 2, top, width, baseline - top)}
                  style={
                    {
                      fill: toggles.patterns ? `url(#funnel-hatch-${i})` : ramp.light[i],
                      '--ramp-dark': ramp.dark[i],
                    } as React.CSSProperties
                  }
                >
                  <title>{`${s.label}: ${formatCompact(s.value)}`}</title>
                </path>
                {/* Direct label: a funnel is always ≤ a handful of stages, so every step is
                    labelled and identity is never colour-alone. */}
                <text
                  data-chart-direct-label={s.key}
                  x={plot.x + i * step + step / 2}
                  y={Math.max(plot.y + 8, top - 6)}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--ink-secondary)"
                  className="tnum"
                >
                  {first > 0 ? `${Math.round((s.value / first) * 100)}%` : '—'}
                </text>
                <rect
                  data-chart-hit={s.key}
                  x={plot.x + i * step}
                  y={plot.y}
                  width={step}
                  height={plot.height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={-1}
                />
              </g>
            );
          })}
        </svg>
        {hover !== null && steps[hover] ? (
          <ChartTooltip
            at={{
              leftPct: ((plot.x + hover * step + step / 2) / W) * 100,
              topPct: (plot.y / H) * 100,
            }}
            title={steps[hover].label}
            rows={[
              { label: result.valueLabel, value: formatCompact(steps[hover].value) },
              {
                label: 'Share of first stage',
                value: first > 0 ? `${Math.round((steps[hover].value / first) * 100)}%` : '—',
              },
            ]}
          />
        ) : null}
      </div>
    </ChartCard>
  );
}
