/**
 * The Reports widget query DSL (§12.2.E) and the shapes its execution returns.
 *
 * `DashboardWidget.kind` is a closed catalogue in the schema; `DashboardWidget.query` is
 * deliberately unconstrained JSON, so the contract lives here: a discriminated union on
 * `source`, one variant per real data need, validated on every write and every read. The filter
 * portion reuses `filterSchema`/`sortSchema` verbatim — there is exactly one filter vocabulary
 * in this product and Reports does not get a second one.
 *
 * Pure: no I/O. `packages/db/src/reports` executes these; `apps/web/components/charts` draws
 * the results. Nothing here knows about either.
 */
import { z } from 'zod';
import { filterSchema, sortSchema, type Filter, type Sort } from './attributes.ts';

/** Mirrors `WidgetKind` in schema.prisma. Never extended ad hoc (§12.2.E). */
export const WIDGET_KINDS = [
  'STAT_TILE',
  'LINE',
  'BAR',
  'STACKED_BAR',
  'FUNNEL',
  'COHORT_HEATMAP',
  'TABLE',
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/**
 * Mirrors `TimelineType` in schema.prisma. Duplicated rather than imported because @nexus/core
 * must not depend on @nexus/db (and the client bundle must not pull Prisma in);
 * `packages/db/src/reports/reports.test.ts` asserts the two lists stay identical.
 */
export const TIMELINE_TYPES = [
  'MESSAGE',
  'COMMENT',
  'MENTION',
  'POST_ENGAGEMENT',
  'LEAD_FORM',
  'EMAIL',
  'MEETING',
  'CALL',
  'NOTE',
  'TASK',
  'STAGE_CHANGE',
  'FIELD_CHANGE',
  'DEAL_EVENT',
  'AI_INSIGHT',
  'SYSTEM',
] as const;
export type ReportTimelineType = (typeof TIMELINE_TYPES)[number];

/** Mirrors `Platform` in schema.prisma; same rationale and same guard test as TIMELINE_TYPES. */
export const REPORT_PLATFORMS = [
  'FACEBOOK',
  'INSTAGRAM',
  'X',
  'LINKEDIN',
  'TIKTOK',
  'YOUTUBE',
  'GMAIL',
  'GOOGLE_CALENDAR',
  'GOOGLE_BUSINESS',
  'KEITARO',
  'MOCK',
] as const;
export type ReportPlatform = (typeof REPORT_PLATFORMS)[number];

/**
 * How far back a widget may look. A dashboard reads recent weeks; the `sentiment_over_time`
 * source in particular scans raw `AiInsight` rows with no persisted daily rollup, so its ceiling
 * is deliberately the lowest of the three (see the note on `sentimentOverTimeQuery`).
 */
/**
 * §12.4's categorical cap, restated where the *data* layer can see it: a result never carries a
 * 9th series, because there is no 9th colour and a generated hue is forbidden. `@nexus/ui`'s
 * `chart-palette` holds the same number for the rendering side; `reports.test.ts` in both
 * packages pins it, and `OTHER_SERIES_LABEL` has to match `OTHER_SERIES_KEY` there.
 */
export const MAX_CHART_SERIES = 8;
export const OTHER_SERIES_LABEL = 'Other';

export const MAX_DAYS = 400;
export const MAX_SENTIMENT_DAYS = 120;
export const MAX_COHORT_WEEKS = 26;
export const MAX_TABLE_ROWS = 200;

const days = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

// ── the variants ──────────────────────────────────────────────────────────────

/**
 * Records of one object type: a count (stat tile), a count grouped by a SELECT/STATUS attribute
 * (bar), or a count per UTC day of `createdAt` (line).
 */
export const recordCountQuery = z.object({
  source: z.literal('record_count'),
  objectTypeApiSlug: z.string().min(1).max(120),
  filters: z.array(filterSchema).max(20).default([]),
  /** Group into series by a SELECT/STATUS/BOOLEAN attribute; id or apiSlug. */
  groupByAttribute: z.string().min(1).max(120).optional(),
  /** Bucket by UTC day of `createdAt` over the last `days` days. */
  byDay: z.boolean().default(false),
  days: days(MAX_DAYS, 30),
});

/**
 * Timeline events: "messages today" (stat tile with a delta), volume over time (line), and
 * channel mix (stacked bar, grouped by `platform`).
 */
export const timelineCountQuery = z.object({
  source: z.literal('timeline_count'),
  types: z.array(z.enum(TIMELINE_TYPES)).max(TIMELINE_TYPES.length).default([]),
  platforms: z.array(z.enum(REPORT_PLATFORMS)).max(REPORT_PLATFORMS.length).default([]),
  groupBy: z.enum(['none', 'platform', 'type']).default('none'),
  byDay: z.boolean().default(true),
  days: days(MAX_DAYS, 14),
});

/**
 * Average conversation sentiment per UTC day, from `AiInsight` rows whose content is a
 * `conversation_summary` (positive = +1, neutral = 0, negative = −1).
 *
 * Performance ceiling, stated plainly: there is no persisted daily aggregation. Every call reads
 * the raw insight rows in the window and buckets them in application code. That is right for a
 * dashboard reading the last few weeks and wrong for a two-year window over millions of
 * insights — hence `MAX_SENTIMENT_DAYS`. The fix when it is needed is a nightly rollup table,
 * not a bigger window.
 */
export const sentimentOverTimeQuery = z.object({
  source: z.literal('sentiment_over_time'),
  days: days(MAX_SENTIMENT_DAYS, 30),
});

/** Current `ListEntry` count per stage of one PIPELINE list, in the list's own stage order. */
export const pipelineFunnelQuery = z.object({
  source: z.literal('pipeline_funnel'),
  listId: z.string().uuid(),
});

/** A filtered, sorted page of records — close to a direct pass-through to `queryRecords`. */
export const recordTableQuery = z.object({
  source: z.literal('record_table'),
  objectTypeApiSlug: z.string().min(1).max(120),
  filters: z.array(filterSchema).max(20).default([]),
  sort: z.array(sortSchema).max(3).default([]),
  /** Attribute ids or apiSlugs, in display order. Empty means "the first five attributes". */
  columns: z.array(z.string().min(1).max(120)).max(20).default([]),
  limit: z.number().int().min(1).max(MAX_TABLE_ROWS).default(25),
});

/**
 * Cohort retention: records grouped by the ISO week they were created in, then the share of each
 * cohort with at least one timeline event in week 0, 1, 2 … after creation. Single-hue heatmap.
 */
export const cohortRetentionQuery = z.object({
  source: z.literal('cohort_retention'),
  objectTypeApiSlug: z.string().min(1).max(120),
  weeks: z.number().int().min(2).max(MAX_COHORT_WEEKS).default(8),
  /** Which event types count as "active"; empty means any. */
  activityTypes: z.array(z.enum(TIMELINE_TYPES)).max(TIMELINE_TYPES.length).default([]),
});

export const widgetQuerySchema = z.discriminatedUnion('source', [
  recordCountQuery,
  timelineCountQuery,
  sentimentOverTimeQuery,
  pipelineFunnelQuery,
  recordTableQuery,
  cohortRetentionQuery,
]);
export type WidgetQuery = z.infer<typeof widgetQuerySchema>;
export type WidgetSource = WidgetQuery['source'];

export const WIDGET_SOURCES = [
  'record_count',
  'timeline_count',
  'sentiment_over_time',
  'pipeline_funnel',
  'record_table',
  'cohort_retention',
] as const;

// ── kind ↔ source compatibility ───────────────────────────────────────────────

/**
 * Which sources a kind can draw. A stat tile cannot render a funnel and a heatmap cannot render
 * a scalar, so the pairing is validated on write rather than discovered at render time.
 */
export const SOURCES_FOR_KIND: Record<WidgetKind, readonly WidgetSource[]> = {
  STAT_TILE: ['record_count', 'timeline_count'],
  LINE: ['timeline_count', 'sentiment_over_time', 'record_count'],
  BAR: ['record_count', 'timeline_count', 'pipeline_funnel'],
  STACKED_BAR: ['timeline_count', 'record_count'],
  FUNNEL: ['pipeline_funnel'],
  COHORT_HEATMAP: ['cohort_retention'],
  TABLE: ['record_table'],
};

export function kindAcceptsSource(kind: WidgetKind, source: WidgetSource): boolean {
  return SOURCES_FOR_KIND[kind].includes(source);
}

/** The result shape a kind expects back from execution. */
export const SHAPE_FOR_KIND = {
  STAT_TILE: 'scalar',
  LINE: 'series',
  BAR: 'series',
  STACKED_BAR: 'series',
  FUNNEL: 'funnel',
  COHORT_HEATMAP: 'matrix',
  TABLE: 'table',
} as const satisfies Record<WidgetKind, WidgetResultShape>;

// ── execution results ─────────────────────────────────────────────────────────

export type WidgetResultShape = 'scalar' | 'series' | 'funnel' | 'matrix' | 'table';

/** "messages today" — one number, a comparison, and a unit. Never a chart (§12.4). */
export type ScalarResult = {
  shape: 'scalar';
  value: number;
  /** The same measure over the immediately preceding window, for the delta. */
  previous: number | null;
  label: string;
  unit: string | null;
};

/**
 * One measure, many series, over an ordered set of buckets. There is exactly one measure here
 * on purpose: §12.4's one-y-axis rule is a property of the *data contract*, not just the
 * renderer — a second measure has nowhere to go, so it has to be a second widget.
 */
export type SeriesResult = {
  shape: 'series';
  /** Bucket keys in x order: ISO days (`2026-09-26`) or category keys. */
  buckets: { key: string; label: string }[];
  /** The complete, unfiltered series key set, in the order colour slots are assigned. */
  seriesKeys: { key: string; label: string }[];
  /** `values[bucketIndex][seriesKey]`, zero-filled. */
  values: Record<string, number>[];
  xKind: 'day' | 'category';
  valueLabel: string;
  /** Set when 9+ series were folded, so the legend can say what "Other" contains. */
  foldedInto?: { other: string; members: string[] };
};

export type FunnelResult = {
  shape: 'funnel';
  steps: { key: string; label: string; value: number }[];
  valueLabel: string;
};

export type MatrixResult = {
  shape: 'matrix';
  rows: { key: string; label: string; size: number }[];
  columns: { key: string; label: string }[];
  /** `cells[rowIndex][columnIndex]` — a share in [0, 1], or null where the cohort is too young. */
  cells: (number | null)[][];
  valueLabel: string;
};

export type TableResult = {
  shape: 'table';
  columns: { key: string; label: string; align: 'left' | 'right' }[];
  rows: { key: string; cells: (string | number | null)[] }[];
  truncated: boolean;
};

export type WidgetResult = ScalarResult | SeriesResult | FunnelResult | MatrixResult | TableResult;

// ── helpers shared by the router, the UI and the execution layer ──────────────

/**
 * Cap a series set at `MAX_CHART_SERIES`, keeping the largest and sweeping the rest into one
 * "Other" bucket. Applied by the execution layer so the chart, its legend and its table view all
 * see the same series set, and so nothing downstream is ever tempted to generate a 9th hue.
 */
export function foldSeriesSet<T extends { key: string; label: string }>(
  series: readonly T[],
  totalOf: (key: string) => number,
): { keys: { key: string; label: string }[]; folded: string[]; remap: (key: string) => string } {
  if (series.length <= MAX_CHART_SERIES) {
    return {
      keys: series.map((s) => ({ key: s.key, label: s.label })),
      folded: [],
      remap: (k) => k,
    };
  }
  const survivors = new Set(
    [...series]
      .sort((a, b) => totalOf(b.key) - totalOf(a.key) || a.key.localeCompare(b.key))
      .slice(0, MAX_CHART_SERIES - 1)
      .map((s) => s.key),
  );
  const kept = series.filter((s) => survivors.has(s.key));
  const folded = series.filter((s) => !survivors.has(s.key)).map((s) => s.key);
  return {
    keys: [
      ...kept.map((s) => ({ key: s.key, label: s.label })),
      { key: OTHER_SERIES_LABEL, label: OTHER_SERIES_LABEL },
    ],
    folded,
    remap: (k) => (survivors.has(k) ? k : OTHER_SERIES_LABEL),
  };
}

/** Parse stored JSON into a `WidgetQuery`, or return the Zod issues for a designed error. */
export function parseWidgetQuery(
  raw: unknown,
): { ok: true; query: WidgetQuery } | { ok: false; issues: string[] } {
  const r = widgetQuerySchema.safeParse(raw);
  if (r.success) return { ok: true, query: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`),
  };
}

/** A sensible starting query for a kind, so "add widget" never begins on an invalid form. */
export function defaultQueryFor(kind: WidgetKind): WidgetQuery {
  switch (kind) {
    case 'STAT_TILE':
      return timelineCountQuery.parse({
        source: 'timeline_count',
        types: ['MESSAGE'],
        byDay: true,
        days: 2,
      });
    case 'LINE':
      return sentimentOverTimeQuery.parse({ source: 'sentiment_over_time', days: 30 });
    case 'BAR':
      return timelineCountQuery.parse({
        source: 'timeline_count',
        groupBy: 'type',
        byDay: false,
        days: 30,
      });
    case 'STACKED_BAR':
      return timelineCountQuery.parse({
        source: 'timeline_count',
        groupBy: 'platform',
        byDay: true,
        days: 14,
      });
    case 'FUNNEL':
      return { source: 'pipeline_funnel', listId: '00000000-0000-0000-0000-000000000000' };
    case 'COHORT_HEATMAP':
      return cohortRetentionQuery.parse({
        source: 'cohort_retention',
        objectTypeApiSlug: 'person',
        weeks: 8,
      });
    case 'TABLE':
      return recordTableQuery.parse({ source: 'record_table', objectTypeApiSlug: 'person' });
  }
}

export type { Filter as ReportFilter, Sort as ReportSort };
