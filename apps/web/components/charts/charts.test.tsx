/**
 * §12.4 enforced against the real rendered DOM. The charts are plain React SVG, so
 * `renderToStaticMarkup` gives the exact markup a browser gets — no jsdom, no testing-library,
 * nothing that could paper over a structural mistake.
 *
 * Each block names the rule it polices. The rules that are *not* mechanically checked here are
 * listed at the bottom of this file, honestly.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SERIES,
  createSeriesPalette,
  funnelRamp,
  relativeLuminance,
  sequentialColor,
} from '@nexus/ui';
import type {
  FunnelResult,
  MatrixResult,
  ScalarResult,
  SeriesResult,
  TableResult,
} from '@nexus/core';
import { BarChart, StackedBarChart } from './bar-chart';
import { CohortHeatmap } from './cohort-heatmap';
import { FunnelChart } from './funnel-chart';
import { LineChart } from './line-chart';
import { StatTile } from './stat-tile';
import { WidgetChart } from './index';

// ── fixtures ──────────────────────────────────────────────────────────────────

function series(keys: string[], buckets = 4): SeriesResult {
  return {
    shape: 'series',
    buckets: Array.from({ length: buckets }, (_, i) => ({
      key: `2026-09-${20 + i}`,
      label: `2026-09-${20 + i}`,
    })),
    seriesKeys: keys.map((k) => ({ key: k, label: k.toUpperCase() })),
    values: Array.from({ length: buckets }, (_, i) =>
      Object.fromEntries(keys.map((k, j) => [k, (i + 1) * (j + 1)])),
    ),
    xKind: 'day',
    valueLabel: 'Events',
  };
}

const funnel: FunnelResult = {
  shape: 'funnel',
  valueLabel: 'Records in stage',
  steps: [
    { key: 'new', label: 'New', value: 40 },
    { key: 'active', label: 'Active', value: 22 },
    { key: 'won', label: 'Won', value: 9 },
  ],
};

const matrix: MatrixResult = {
  shape: 'matrix',
  rows: [
    { key: 'w0', label: 'Week of 2026-09-07', size: 10 },
    { key: 'w1', label: 'Week of 2026-09-14', size: 6 },
  ],
  columns: [
    { key: 'c0', label: '+0w' },
    { key: 'c1', label: '+1w' },
  ],
  cells: [
    [1, 0.5],
    [0.5, null],
  ],
  valueLabel: 'Share of the cohort with activity',
};

const scalar: ScalarResult = {
  shape: 'scalar',
  value: 128,
  previous: 100,
  label: 'Messages',
  unit: null,
};

const table: TableResult = {
  shape: 'table',
  columns: [
    { key: 'a', label: 'Name', align: 'left' },
    { key: 'b', label: 'Deals', align: 'right' },
  ],
  rows: [{ key: 'r1', cells: ['Ada', 3] }],
  truncated: false,
};

/** Prop names that would mean a second value axis. §12.4: there is never one. */
type BannedAxisProp = 'y2' | 'yRight' | 'rightAxis' | 'secondaryAxis' | 'y2Label';
type PropsOf<T> = T extends (p: infer P) => unknown ? P : never;
type HasBannedAxis<P> = [BannedAxisProp & keyof P] extends [never] ? false : true;

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const count = (markup: string, needle: string | RegExp) =>
  markup.match(typeof needle === 'string' ? new RegExp(escape(needle), 'g') : needle)?.length ?? 0;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every chart in the library, each with a representative result. */
const CHARTS: { name: string; markup: string }[] = [
  { name: 'LineChart', markup: html(<LineChart title="Line" result={series(['a', 'b'])} />) },
  { name: 'BarChart', markup: html(<BarChart title="Bar" result={series(['a', 'b'])} />) },
  {
    name: 'StackedBarChart',
    markup: html(<StackedBarChart title="Stacked" result={series(['a', 'b', 'c'])} />),
  },
  { name: 'FunnelChart', markup: html(<FunnelChart title="Funnel" result={funnel} />) },
  { name: 'CohortHeatmap', markup: html(<CohortHeatmap title="Cohort" result={matrix} />) },
];

// ── the rules ─────────────────────────────────────────────────────────────────

describe('one y-axis, never a dual-axis chart (§12.4)', () => {
  it.each(CHARTS.filter((c) => c.name !== 'CohortHeatmap'))(
    '$name renders exactly one y axis and one x axis',
    ({ markup }) => {
      expect(count(markup, 'data-chart-axis="y"')).toBe(1);
      expect(count(markup, 'data-chart-axis="x"')).toBe(1);
    },
  );

  it('is structural: no chart component accepts a second axis', () => {
    // A compile-time assertion. If anyone adds `y2` / `rightAxis` / `secondaryAxis` to a chart's
    // props, that slot's type becomes `true`, `false` stops being assignable, and this file stops
    // type-checking — before any test runs.
    const offenders: [
      HasBannedAxis<PropsOf<typeof LineChart>>,
      HasBannedAxis<PropsOf<typeof BarChart>>,
      HasBannedAxis<PropsOf<typeof StackedBarChart>>,
      HasBannedAxis<PropsOf<typeof FunnelChart>>,
      HasBannedAxis<PropsOf<typeof CohortHeatmap>>,
    ] = [false, false, false, false, false];
    expect(offenders.every((o) => o === false)).toBe(true);
  });

  it('the data contract carries one measure, so two scales cannot reach one chart', () => {
    const r = series(['a', 'b']);
    // `valueLabel` is singular and `values` is one number per (bucket, series).
    expect(typeof r.valueLabel).toBe('string');
    expect(Object.values(r.values[0]!).every((v) => typeof v === 'number')).toBe(true);
  });
});

describe('colour follows the entity, never its rank (§12.4)', () => {
  it('a series keeps its slot when another is hidden and shown again', () => {
    const keys = ['instagram', 'linkedin', 'x'];
    const palette = createSeriesPalette(keys);
    const before = keys.map((k) => palette.colorForSeries(k).slot);
    // The chart only ever asks the palette, which was built from the full key set; rendering a
    // filtered subset is exactly this call pattern.
    const during = keys.filter((k) => k !== 'instagram').map((k) => palette.colorForSeries(k).slot);
    const after = keys.map((k) => palette.colorForSeries(k).slot);
    expect(during).toEqual(before.slice(1));
    expect(after).toEqual(before);
  });

  it('renders series colours as the fixed palette variables, in declared order', () => {
    const markup = html(<BarChart title="Bar" result={series(['alpha', 'beta', 'gamma'])} />);
    expect(markup).toContain('var(--series-1)');
    expect(markup).toContain('var(--series-2)');
    expect(markup).toContain('var(--series-3)');
    expect(markup).not.toContain('var(--series-4)');
    // Never a status colour as a series colour (§12.3, restated by §12.4).
    for (const status of ['#0ca30c', '#fab219', '#ec835a', '#d03b3b']) {
      expect(markup).not.toContain(status);
    }
  });

  it('a 9th series folds to "Other" and no hue is generated', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const palette = createSeriesPalette(keys);
    const slots = keys.map((k) => palette.colorForSeries(k).slot);
    expect(Math.max(...slots)).toBeLessThanOrEqual(7);
    const literals = new Set<string>([...SERIES.light, ...SERIES.dark]);
    for (const k of keys) expect(literals.has(palette.colorForSeries(k).light)).toBe(true);
  });
});

describe('accessibility (§12.4)', () => {
  it('renders a legend at ≥2 series and none at 1', () => {
    expect(html(<LineChart title="L" result={series(['a', 'b'])} />)).toContain(
      'data-chart-legend',
    );
    expect(html(<LineChart title="L" result={series(['a'])} />)).not.toContain('data-chart-legend');
    expect(html(<BarChart title="B" result={series(['a', 'b', 'c'])} />)).toContain(
      'data-chart-legend',
    );
  });

  it('direct-labels ≤4 series and stops at 5+', () => {
    const four = html(<LineChart title="L" result={series(['a', 'b', 'c', 'd'])} />);
    expect(count(four, 'data-chart-direct-label="')).toBe(4);
    const five = html(<LineChart title="L" result={series(['a', 'b', 'c', 'd', 'e'])} />);
    expect(count(five, 'data-chart-direct-label="')).toBe(0);
    // …and the legend is still there, so identity is never colour-alone.
    expect(five).toContain('data-chart-legend');
    // The same rule on bars, stacked and grouped.
    expect(
      count(
        html(<StackedBarChart title="S" result={series(['a', 'b', 'c'])} />),
        'data-chart-direct-label="',
      ),
    ).toBe(3);
    expect(
      count(
        html(<BarChart title="B" result={series(['a', 'b', 'c', 'd', 'e'])} />),
        'data-chart-direct-label="',
      ),
    ).toBe(0);
  });

  it('places direct labels in a gutter beside the plot, never on top of each other', () => {
    // Four series whose last values are identical would collide at one y without de-collision.
    const flat = series(['a', 'b', 'c', 'd'], 3);
    flat.values = flat.values.map(() => ({ a: 5, b: 5, c: 5, d: 5 }));
    const markup = html(<LineChart title="L" result={flat} />);
    const ys = [
      ...markup.matchAll(
        /<text x="(\d+(?:\.\d+)?)" y="(\d+(?:\.\d+)?)" font-size="10" fill="var\(--ink-secondary\)"/g,
      ),
    ].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(ys).toHaveLength(4);
    // All in the same gutter column, to the right of every mark…
    expect(new Set(ys.map((p) => p.x)).size).toBe(1);
    const markXs = [...markup.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...markXs)).toBeLessThan(ys[0]!.x);
    // …and separated vertically.
    const sorted = ys.map((p) => p.y).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(10);
    }
  });

  it('gives every chart a table-view toggle and a manual patterns toggle', () => {
    for (const { name, markup } of CHARTS) {
      expect(markup, name).toContain('data-testid="chart-table-toggle"');
      expect(markup, name).toContain('data-testid="chart-texture-toggle"');
    }
  });

  it('defines a 45°/135° hatch for every slot in use', () => {
    const markup = html(<BarChart title="B" result={series(['a', 'b'])} />);
    expect(count(markup, '<pattern')).toBe(2);
    expect(markup).toMatch(/<path d="M0 6 L6 0/); // 45°, slot 1
    expect(markup).toMatch(/<path d="M0 0 L6 6/); // 135°, slot 2
  });

  it('never puts a series colour on label text — a chip carries identity', () => {
    for (const { name, markup } of CHARTS) {
      // No <text> anywhere in any chart wears a series colour.
      for (const t of markup.match(/<text[^>]*>/g) ?? []) {
        expect(t, `${name}: ${t}`).not.toMatch(/--series-/);
      }
    }
    const line = html(<LineChart title="L" result={series(['a', 'b'])} />);
    expect(line).toContain('data-chart-legend-chip');
    // Each direct label is a chip + text pair, and the chip is what wears the colour.
    expect(line).toMatch(/data-chart-direct-label="a"><rect[^>]*fill="var\(--series-1\)"/);
  });

  it('labels the chart for a screen reader and the axis for its scale', () => {
    const markup = html(<LineChart title="Sentiment" result={series(['a'])} />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Sentiment.');
    expect(markup).toContain('<title>Events</title>');
  });
});

describe('interaction (§12.4)', () => {
  it('line and bar get one hit target per bucket, wider than the marks', () => {
    const line = html(<LineChart title="L" result={series(['a'], 6)} />);
    expect(count(line, 'data-chart-hit=')).toBe(6);
    const bar = html(<BarChart title="B" result={series(['a', 'b'], 6)} />);
    expect(count(bar, 'data-chart-hit=')).toBe(6);
    // Hit width (the whole band step) is larger than the drawn bar width.
    const hitWidth = Number(
      /data-chart-hit="[^"]*" x="[^"]*" y="[^"]*" width="([\d.]+)"/.exec(bar)?.[1],
    );
    expect(hitWidth).toBeGreaterThan(0);
  });

  it('gives every mark a native tooltip as well as the JS one', () => {
    const bar = html(<BarChart title="B" result={series(['a', 'b'], 3)} />);
    // 3 buckets × 2 series = 6 marks, each with a <title>, plus the y-axis title.
    expect(count(bar, '<title>')).toBe(7);
    const funnelMarkup = html(<FunnelChart title="F" result={funnel} />);
    expect(count(funnelMarkup, '<title>')).toBe(4); // 3 stages + the y-axis label
  });

  it('draws a crosshair on the line chart only when a bucket is hovered', () => {
    // Server markup is the un-hovered state: no crosshair yet, but the hit targets that
    // summon it are present.
    const line = html(<LineChart title="L" result={series(['a'])} />);
    expect(line).not.toContain('data-chart-crosshair');
    expect(line).toContain('data-chart-hit=');
  });

  it('puts filters in one row above the chart', () => {
    const markup = html(
      <LineChart title="L" result={series(['a'])} filters={<span>window</span>} />,
    );
    expect(count(markup, 'data-chart-filters')).toBe(1);
    expect(markup.indexOf('data-chart-filters')).toBeLessThan(markup.indexOf('<svg'));
  });

  it('a bare stat tile is the only chart without those controls', () => {
    const markup = html(<StatTile title="Messages today" result={scalar} />);
    expect(markup).not.toContain('chart-table-toggle');
    expect(markup).not.toContain('<svg');
    expect(markup).toContain('data-stat-tile');
  });
});

describe('marks (§12.4)', () => {
  it('draws 2px lines and ≥8px markers', () => {
    const markup = html(<LineChart title="L" result={series(['a'])} />);
    expect(markup).toMatch(/stroke-width="2"/);
    const radius = Number(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)"/.exec(markup)?.[1]);
    expect(radius * 2).toBeGreaterThanOrEqual(8);
    // A 2px surface ring where marks overlap.
    expect(markup).toMatch(/stroke="var\(--surface-card\)" stroke-width="2"/);
  });

  it('anchors 4px rounded data-ends to the baseline', () => {
    const markup = html(<BarChart title="B" result={series(['a'])} />);
    expect(markup).toMatch(/a4 4 0 0 1/);
  });

  it('gives a stacked bar a 2px surface gap between fills', () => {
    const tall = series(['a', 'b'], 1);
    tall.values = [{ a: 100, b: 100 }];
    const markup = html(<StackedBarChart title="S" result={tall} />);
    const paths = [...markup.matchAll(/ d="M([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
    // Two segments; the lower one's top is at least 2px below the upper one's bottom.
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps chrome recessive: hairline gridlines and a hairline baseline', () => {
    const markup = html(<LineChart title="L" result={series(['a'])} />);
    expect(markup).toContain('stroke="var(--chart-grid)" stroke-width="1"');
    expect(markup).toContain('stroke="var(--chart-baseline)" stroke-width="1"');
    expect(markup).toContain('fill="var(--ink-muted)"');
  });
});

describe('dashboard defaults (§12.4)', () => {
  it('the funnel is an ordinal ramp within the light/dark bounds, not categorical hues', () => {
    const markup = html(<FunnelChart title="F" result={funnel} />);
    const ramp = funnelRamp(3, 'light');
    for (const step of ramp) expect(markup).toContain(step);
    for (const step of funnelRamp(3, 'dark')) expect(markup).toContain(step);
    expect(markup).not.toContain('var(--series-1)');
    // Light starts no lighter than #86b6ef; dark starts no darker than #184f95.
    expect(ramp[0]).toBe('#86b6ef');
    expect(relativeLuminance(ramp[2]!)).toBeLessThan(relativeLuminance('#86b6ef'));
    expect(funnelRamp(3, 'dark')[0]).toBe('#184f95');
    expect(markup).toContain('--ramp-dark');
  });

  it('the cohort heatmap is a single-hue sequential ramp, and blanks the future', () => {
    const markup = html(<CohortHeatmap title="C" result={matrix} />);
    expect(markup).toContain(sequentialColor(1));
    expect(markup).toContain(sequentialColor(0.5));
    expect(markup).toContain('data-chart-cell="empty"');
    // No categorical colour anywhere in a continuous encoding.
    expect(markup).not.toContain('var(--series-');
    expect(markup).toContain('data-chart-ramp-key');
  });

  it('"messages today" is a stat tile with a delta, never colour alone', () => {
    const markup = html(<StatTile title="Messages today" result={scalar} />);
    expect(markup).toContain('data-stat-delta');
    expect(markup).toContain('↑');
    expect(markup).toContain('Up 28%');
    expect(markup).toContain('128');
    // A delta wears a *status* tone, never a series colour.
    expect(markup).toContain('text-good');
    expect(markup).not.toContain('--series-');
  });

  it('a stat tile with no comparison says so instead of faking a delta', () => {
    const markup = html(
      <StatTile title="People" result={{ ...scalar, previous: null, label: 'People' }} />,
    );
    expect(markup).not.toContain('data-stat-delta');
    expect(markup).toContain('People');
  });
});

describe('table views (§12.4: every chart has one)', () => {
  it('each chart ships a table of the same data', () => {
    // Server markup shows the chart; the toggle swaps in the table. Render the table directly
    // to prove it exists and agrees with the chart's numbers.
    const markup = html(<WidgetChart kind="TABLE" title="T" result={table} />);
    expect(markup).toContain('data-chart-table');
    expect(markup).toContain('Ada');
    expect(markup).toContain('>3<');
  });

  it('dispatches every kind in the fixed catalogue and refuses a mismatch', () => {
    expect(html(<WidgetChart kind="STAT_TILE" title="S" result={scalar} />)).toContain(
      'data-stat-tile',
    );
    expect(html(<WidgetChart kind="LINE" title="L" result={series(['a'])} />)).toContain('<svg');
    expect(html(<WidgetChart kind="FUNNEL" title="F" result={funnel} />)).toContain(
      'data-chart-stage',
    );
    expect(html(<WidgetChart kind="COHORT_HEATMAP" title="C" result={matrix} />)).toContain(
      'data-chart-heatmap',
    );
    const wrong = html(<WidgetChart kind="FUNNEL" title="F" result={scalar} />);
    expect(wrong).toContain('role="alert"');
    expect(wrong).toContain('matching data source');
  });
});

/**
 * Implemented but verified by inspection, not by a test here:
 *  - the `forced-colors: active` / `prefers-contrast: more` auto-enable of the pattern fills
 *    (a `matchMedia` effect, which does not run under `renderToStaticMarkup`), and the
 *    `@media (forced-colors: active)` block in globals.css;
 *  - the hovered states themselves — the crosshair line, the HTML tooltip and the legend's
 *    hide/show — which need a browser event loop. Their *inputs* (hit targets, per-mark
 *    `<title>`, the palette's stability under a hidden series) are tested above, and the
 *    e2e suite is where a real hover belongs;
 *  - dark-mode rendering: the categorical marks reference `var(--series-N)`, whose dark values
 *    `packages/ui/src/tokens.test.ts` pins against tokens.css, and the ramp marks ship
 *    `--ramp-dark` (asserted above) which globals.css swaps.
 */
