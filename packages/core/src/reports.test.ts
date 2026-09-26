/**
 * The widget query DSL's contract: the union discriminates, defaults fill in, the filter
 * vocabulary is the shared one, and a kind can only be paired with a source it can draw.
 */
import { describe, expect, it } from 'vitest';
import { FILTER_OPS } from './attributes.ts';
import {
  MAX_SENTIMENT_DAYS,
  SHAPE_FOR_KIND,
  SOURCES_FOR_KIND,
  WIDGET_KINDS,
  WIDGET_SOURCES,
  defaultQueryFor,
  kindAcceptsSource,
  parseWidgetQuery,
  widgetQuerySchema,
} from './reports.ts';

describe('widgetQuerySchema', () => {
  it('discriminates on source and fills defaults', () => {
    const r = widgetQuerySchema.parse({ source: 'record_table', objectTypeApiSlug: 'person' });
    expect(r).toEqual({
      source: 'record_table',
      objectTypeApiSlug: 'person',
      filters: [],
      sort: [],
      columns: [],
      limit: 25,
    });
  });

  it('reuses the shared filter vocabulary rather than inventing a second one', () => {
    const q = widgetQuerySchema.parse({
      source: 'record_count',
      objectTypeApiSlug: 'deal',
      filters: [{ attribute: 'stage', op: 'eq', value: 'won' }],
    });
    expect(q.source).toBe('record_count');
    if (q.source !== 'record_count') throw new Error('unreachable');
    expect(q.filters[0]?.op).toBe('eq');
    // Every operator the rest of the app accepts is accepted here too.
    for (const op of FILTER_OPS) {
      expect(
        widgetQuerySchema.safeParse({
          source: 'record_count',
          objectTypeApiSlug: 'deal',
          filters: [{ attribute: 'stage', op, value: 'x' }],
        }).success,
      ).toBe(true);
    }
    expect(
      widgetQuerySchema.safeParse({
        source: 'record_count',
        objectTypeApiSlug: 'deal',
        filters: [{ attribute: 'stage', op: 'regex', value: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown source and a malformed uuid', () => {
    expect(parseWidgetQuery({ source: 'sql' }).ok).toBe(false);
    expect(parseWidgetQuery({ source: 'pipeline_funnel', listId: 'nope' }).ok).toBe(false);
    const bad = parseWidgetQuery({ source: 'pipeline_funnel', listId: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toContain('listId');
  });

  it('caps the sentiment window lower than the others, because it has no rollup', () => {
    expect(
      widgetQuerySchema.safeParse({ source: 'sentiment_over_time', days: MAX_SENTIMENT_DAYS })
        .success,
    ).toBe(true);
    expect(
      widgetQuerySchema.safeParse({ source: 'sentiment_over_time', days: MAX_SENTIMENT_DAYS + 1 })
        .success,
    ).toBe(false);
    expect(
      widgetQuerySchema.safeParse({ source: 'timeline_count', days: MAX_SENTIMENT_DAYS + 1 })
        .success,
    ).toBe(true);
  });
});

describe('kind ↔ source pairing', () => {
  it("covers exactly the schema's fixed widget catalogue", () => {
    expect(WIDGET_KINDS).toEqual([
      'STAT_TILE',
      'LINE',
      'BAR',
      'STACKED_BAR',
      'FUNNEL',
      'COHORT_HEATMAP',
      'TABLE',
    ]);
    expect(Object.keys(SOURCES_FOR_KIND).sort()).toEqual([...WIDGET_KINDS].sort());
    expect(Object.keys(SHAPE_FOR_KIND).sort()).toEqual([...WIDGET_KINDS].sort());
  });

  it('names only sources the union actually has, and every source is reachable', () => {
    const reachable = new Set<string>();
    for (const kind of WIDGET_KINDS) {
      for (const source of SOURCES_FOR_KIND[kind]) {
        expect(WIDGET_SOURCES).toContain(source);
        reachable.add(source);
      }
    }
    expect([...reachable].sort()).toEqual([...WIDGET_SOURCES].sort());
  });

  it('refuses a pairing that cannot be drawn', () => {
    expect(kindAcceptsSource('STAT_TILE', 'pipeline_funnel')).toBe(false);
    expect(kindAcceptsSource('COHORT_HEATMAP', 'record_table')).toBe(false);
    expect(kindAcceptsSource('TABLE', 'record_table')).toBe(true);
    expect(kindAcceptsSource('STACKED_BAR', 'timeline_count')).toBe(true);
  });

  it('gives every kind a valid starting query', () => {
    for (const kind of WIDGET_KINDS) {
      const q = defaultQueryFor(kind);
      expect(widgetQuerySchema.safeParse(q).success).toBe(true);
      expect(kindAcceptsSource(kind, q.source)).toBe(true);
    }
  });
});
