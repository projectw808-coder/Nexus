# ADR-023 — Where the chart primitives live, how §12.4's colour binding works, and the widget query DSL

**Status:** accepted (Phase 11) · **Spec:** §12.2.E, §12.3, §12.4, §16 Phase 11 · **Builds on:** ADR-009, ADR-011

> **Merge note:** four engineers are working Phase 11 concurrently. If another ADR claimed 023
> first, renumber this one; nothing references it by number.

## Context

Phase 11 ships the Reports screen: a dashboard builder over a fixed widget catalogue
(`STAT_TILE | LINE | BAR | STACKED_BAR | FUNNEL | COHORT_HEATMAP | TABLE`, fixed in the schema by
`WidgetKind`), whose every visualization must satisfy §12.4. §12.4 is a list of constraints, not
preferences, and the acceptance criterion is that a reviewer can read the rendering code against
each rule. Three questions had to be answered before writing any of it.

## Decisions

### 1. The chart library is split: pure rules in `@nexus/ui`, React SVG in `apps/web/components/charts`

`@nexus/ui` has no React dependency and no JSX — it is tokens plus theme helpers. Rather than add
React to it (and a build/test setup for components) the split is:

- **`packages/ui/src/chart-palette.ts`** and **`chart-geometry.ts`** — the _rules_, as pure
  functions: the categorical palette and its key→slot binding, the sequential/diverging/funnel
  ramps, the mark constants (2px strokes, ≥8px markers, 4px data-ends, the 2px surface gap and
  ring), scales, ticks, stacking and the path builders. These are where §12.4's numbers live, and
  they are unit-tested with no DOM at all (`chart-palette.test.ts`, `chart-geometry.test.ts`).
- **`apps/web/components/charts/`** — thin React SVG components that consume those functions.
  `chart-frame.tsx` implements every rule that is shared (one y axis, the legend, the direct
  labels, the table toggle, the patterns toggle, the hatch `<pattern>` defs, the tooltip shell);
  the five chart components add only their own marks.

**SVG, not Canvas.** SVG is inspectable, so "the DOM never contains two y-axis elements" is a
literal assertion rather than a promise; it is accessible by default (`role="img"`, `<title>` per
mark); it prints and scales; and a dashboard's data volumes are nowhere near where Canvas would
win. The consequence — the component tests use `react-dom/server`'s `renderToStaticMarkup` and
assert against real markup — is the point, and it also meant **no new test dependency**: no
jsdom, no `@testing-library/react`. The one config change is
`apps/web/vitest.config.ts` gaining `**/*.test.tsx` and `oxc: { jsx: { runtime: 'automatic' } }`
(the app's tsconfig says `jsx: preserve`, which Next compiles but the test runner does not).

### 2. Colour is bound to a series key by a per-chart memoising palette, never to a visible index

§12.4 says two things that pull against each other: the eight colours are "assigned in this fixed
order, never cycled", **and** "colour follows the entity, never its rank … not `index` in the
currently-visible array". A pure hash satisfies the second and breaks the first (the first series
would rarely be blue).

`createSeriesPalette(declaredKeys)` resolves both. It is created **once per chart from the
complete, unfiltered series key set** (which the execution layer returns in a canonical order —
the `Platform`/`TimelineType` enum order, or the attribute's own option order, never by size) and
hands out slots 1…8 in that order, memoising each assignment. Hiding a series and showing it
again is just another `colorForSeries(key)` call against the same memo, so survivors cannot be
repainted; nothing in the rendering path ever looks at an index into the visible array. A key the
palette never saw declared still gets a _content-derived_ slot — `hash(key) % 8`, linear-probed to
the first free slot — so two charts over the same entity agree even without a declaration.

The ninth distinct series is never a generated hue. Folding happens in two places that agree on
the same `'Other'` label: `foldSeriesSet` in `@nexus/core` caps a _result_ at 8 series (keeping the
largest, sweeping the tail into `Other`) so the chart, its legend and its table view all see the
same set; `foldSeriesKeys` in `@nexus/ui` is the renderer's belt-and-braces for a palette handed
more than 8 keys anyway. Eight keys keep eight own slots; nine or more keep the first seven and
`Other` takes slot 8.

Categorical fills are emitted as `var(--series-N)`, which `tokens.css` already redefines per mode —
so dark mode is a _selected_ palette for free, never an inversion. An interpolated ramp cannot be a
CSS variable, so funnel and heatmap marks ship both steps (`fill` = light, `--ramp-dark` = dark) and
`.chart-ramp` in `globals.css` swaps them with the same guarded media query the design system uses.

**One y-axis is enforced structurally.** `Axes` takes a single `y` scale and there is no second-axis
prop anywhere in the library — not on `Axes`, not on any chart. `SeriesResult` carries one measure
(`valueLabel`, singular; `values[bucket][seriesKey]` is one number), so a second scale has nowhere
to live even in the data contract. A test asserts this at compile time as well as in the markup.

### 3. `WidgetQuery` is a Zod discriminated union on `source`, and reuses the one filter vocabulary

`DashboardWidget.query` is unconstrained `Json` in the schema on purpose, so the contract lives in
`packages/core/src/reports.ts` as `widgetQuerySchema` — a discriminated union on `source` with one
variant per real data need, parsed on **every** write and **every** read (a stale query becomes a
designed error on one tile, never a crashed dashboard). Its filter and sort portions are
`filterSchema`/`sortSchema` from `attributes.ts` verbatim: Reports does not get a second filter
language. A `SOURCES_FOR_KIND` table gates which kind may draw which source, checked on write.

Six sources cover the catalogue:

| source                | serves                                          | executed by                                                                            |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `record_count`        | stat tile, bar, line, stacked bar               | `countRecords` (exact, one call per group) or paged `queryRecords` + UTC-day bucketing |
| `timeline_count`      | "messages today", channel mix, volume over time | `timelineEvent.count` / `findMany` + day bucketing                                     |
| `sentiment_over_time` | sentiment over time (line)                      | raw `AiInsight` rows, bucketed and averaged                                            |
| `pipeline_funnel`     | funnel                                          | `stagesOf` + `listEntry.groupBy`                                                       |
| `record_table`        | table                                           | `queryRecords` pass-through                                                            |
| `cohort_retention`    | cohort heatmap                                  | paged records + their timeline events, bucketed by ISO week                            |

`packages/db/src/reports/buckets.ts` follows `dailyRunActivity`'s Phase 9 pattern exactly: read the
window, bucket in application code, return a fixed number of zero-filled buckets.

## Consequences

- **Stated performance ceilings, not silent ones.** `sentiment_over_time` reads raw `AiInsight`
  rows because Phase 10 persists no daily aggregate; that is right for a dashboard reading recent
  weeks and wrong for a two-year window over millions of insights, so its window is capped at
  `MAX_SENTIMENT_DAYS = 120` (against 400 for the others) and the schema comment says why. The
  fix when it is needed is a nightly rollup table, not a bigger cap. `record_count` with `byDay`
  and `cohort_retention` page real rows through `queryRecords` and stop at `ROW_CEILING = 5,000`,
  reporting a partial result rather than a wrong one.
- **A zero and a gap are different.** A day with no conversation summaries omits the series key
  entirely and the line _breaks_ there, rather than drawing a neutral day nobody measured. A
  cohort week that has not happened yet is `null` and renders as an empty cell, not 0%.
- **The sequential ramp is used verbatim in both modes.** §12.4 gives one ramp
  (`#cde2fb → #0d366b`) and no dark counterpart. Inventing a second one, or reversing this one in
  dark mode, would both be inventions; the heatmap flips its _ink_ on dark cells instead so the
  encoding survives. The funnel _does_ get a selected dark ramp, because §12.4 states its dark
  bound (`#184f95`) explicitly.
- **The patterns toggle is a real control.** §12.4 asks for a texture fill for `forced-colors`,
  print and "the accessibility setting". A media query alone would leave out someone with a
  colour-vision deficiency in an ordinary browser, so every chart ships a visible "Patterns"
  button; `forced-colors: active` and `prefers-contrast: more` additionally turn it on by
  themselves.
- Dashboards are permissioned as one subject, `'Dashboard'` — a widget has no meaning apart from
  the dashboard it sits on. Managers and above build them; everyone who can read records can read
  them.
