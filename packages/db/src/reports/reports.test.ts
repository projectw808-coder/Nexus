/**
 * Every `WidgetQuery` source executed against a real, seeded database: the day buckets are
 * zero-filled and the right length, the counts are the counts, the funnel follows the list's own
 * stage order, sentiment averages per day and *breaks* where nothing was measured, and cohort
 * retention leaves the future blank instead of calling it zero.
 *
 * Also the guard that @nexus/core's mirrored enum lists have not drifted from schema.prisma.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_CHART_SERIES,
  OTHER_SERIES_LABEL,
  REPORT_PLATFORMS,
  TIMELINE_TYPES,
  widgetQuerySchema,
  type SeriesResult,
} from '@nexus/core';
import { Platform, TimelineType } from '../generated/prisma/enums.ts';
import type { Actor } from '../scoped.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { executeWidgetQuery } from './execute.ts';
import { dayKeys, isoWeekStart, utcDay, weeksBetween } from './buckets.ts';

/** Fixed "now" so the day buckets are the same on every run and across a midnight boundary. */
const NOW = new Date('2026-09-26T15:00:00.000Z');
const daysAgo = (n: number, hour = 9) => new Date(Date.UTC(2026, 8, 26 - n, hour, 0, 0)); // month 8 = September

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let pipelineListId: string;
let collectionListId: string;

async function run(query: unknown) {
  const parsed = widgetQuerySchema.parse(query);
  return db.runtime.withTenant(actor, (t) =>
    executeWidgetQuery({ db: t, workspaceId, now: NOW }, parsed),
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  const user = await db.prisma.user.create({
    data: { email: 'owner@reports.test', name: 'Owner' },
  });
  const ws = await db.tenancy.createWorkspace({
    name: 'Reports',
    slug: 'reports-test',
    ownerUserId: user.id,
  });
  workspaceId = ws.id;
  actor = { workspaceId, userId: user.id, role: 'OWNER', grants: [] };

  await db.runtime.withTenant(actor, async (t) => {
    const person = await t.objectType.create({
      data: { workspaceId, apiSlug: 'contact', singular: 'Contact', plural: 'Contacts' },
    });
    const name = await t.attribute.create({
      data: {
        workspaceId,
        objectTypeId: person.id,
        apiSlug: 'name',
        title: 'Name',
        type: 'TEXT',
        position: 0,
      },
    });
    const tier = await t.attribute.create({
      data: {
        workspaceId,
        objectTypeId: person.id,
        apiSlug: 'tier',
        title: 'Tier',
        type: 'SELECT',
        position: 1,
        config: {
          options: [
            { id: 'gold', label: 'Gold' },
            { id: 'silver', label: 'Silver' },
          ],
        },
      },
    });
    // 4 people: two created 1 day ago (gold, silver), one 3 days ago (gold), one 10 days ago
    // (no tier). `createdAt` is set explicitly so the buckets are deterministic.
    const people: { at: Date; tier: string | null; label: string }[] = [
      { at: daysAgo(1), tier: 'gold', label: 'Ada' },
      { at: daysAgo(1, 11), tier: 'silver', label: 'Grace' },
      { at: daysAgo(3), tier: 'gold', label: 'Alan' },
      { at: daysAgo(10), tier: null, label: 'Edsger' },
    ];
    const created: string[] = [];
    for (const p of people) {
      const row = await t.record.create({
        data: {
          workspaceId,
          objectTypeId: person.id,
          values: { [name.id]: p.label, ...(p.tier ? { [tier.id]: p.tier } : {}) },
          createdAt: p.at,
        },
      });
      created.push(row.id);
    }

    // Timeline: messages and comments across two platforms and three days.
    const events: { type: TimelineType; platform: Platform | null; at: Date; recordId?: string }[] =
      [
        { type: 'MESSAGE', platform: 'INSTAGRAM', at: daysAgo(0), recordId: created[0] },
        { type: 'MESSAGE', platform: 'INSTAGRAM', at: daysAgo(0, 12), recordId: created[0] },
        { type: 'MESSAGE', platform: 'LINKEDIN', at: daysAgo(0, 13) },
        { type: 'MESSAGE', platform: 'LINKEDIN', at: daysAgo(2) },
        { type: 'COMMENT', platform: 'INSTAGRAM', at: daysAgo(2, 10) },
        { type: 'MESSAGE', platform: null, at: daysAgo(4) },
        // Outside a 3-day window, inside a 14-day one.
        { type: 'MESSAGE', platform: 'INSTAGRAM', at: daysAgo(9), recordId: created[3] },
      ];
    let n = 0;
    for (const e of events) {
      await t.timelineEvent.create({
        data: {
          workspaceId,
          type: e.type,
          platform: e.platform,
          occurredAt: e.at,
          summary: `event ${n++}`,
          ...(e.recordId ? { recordId: e.recordId } : {}),
        },
      });
    }

    // A pipeline with three stages and entries sitting in two of them.
    const pipeline = await t.list.create({
      data: {
        workspaceId,
        objectTypeId: person.id,
        name: 'Onboarding',
        kind: 'PIPELINE',
        settings: { stages: ['new', 'active', 'won'] },
      },
    });
    pipelineListId = pipeline.id;
    const stageAttr = await t.listAttribute.create({
      data: {
        workspaceId,
        listId: pipeline.id,
        apiSlug: 'stage',
        title: 'Stage',
        type: 'STATUS',
        position: 0,
        config: {
          options: [
            { id: 'new', label: 'New', category: 'open' },
            { id: 'active', label: 'Active', category: 'open' },
            { id: 'won', label: 'Won', category: 'won' },
          ],
        },
      },
    });
    const stages = ['new', 'new', 'won'];
    for (let i = 0; i < stages.length; i++) {
      await t.listEntry.create({
        data: {
          workspaceId,
          listId: pipeline.id,
          recordId: created[i]!,
          stage: stages[i]!,
          position: i,
          values: { [stageAttr.id]: stages[i]! },
        },
      });
    }
    const collection = await t.list.create({
      data: { workspaceId, objectTypeId: person.id, name: 'Everyone', kind: 'COLLECTION' },
    });
    collectionListId = collection.id;

    // AI summaries: two on one day (positive + negative → average 0), one negative two days
    // later. The day in between is measured by nobody.
    const summaries: { at: Date; sentiment: string }[] = [
      { at: daysAgo(4), sentiment: 'positive' },
      { at: daysAgo(4, 13), sentiment: 'negative' },
      { at: daysAgo(2), sentiment: 'negative' },
    ];
    for (const s of summaries) {
      await t.aiInsight.create({
        data: {
          workspaceId,
          kind: 'SUMMARY',
          model: 'mock',
          promptVersion: 'v1',
          confidence: 0.9,
          generatedAt: s.at,
          content: {
            kind: 'conversation_summary',
            summary: 's',
            intent: 'support',
            sentiment: s.sentiment,
            urgency: 'low',
            nextAction: 'reply',
            confidence: 0.9,
            citations: [],
          },
        },
      });
    }
    // A non-summary insight in the same window must be ignored by the sentiment source.
    await t.aiInsight.create({
      data: {
        workspaceId,
        kind: 'SUMMARY',
        model: 'mock',
        promptVersion: 'v1',
        confidence: 0.5,
        generatedAt: daysAgo(3),
        content: { kind: 'relationship_brief', sentiment: 'positive' },
      },
    });
  });
});

afterAll(async () => {
  await db.close();
});

describe('@nexus/core mirrors of schema.prisma enums', () => {
  it('has not drifted', () => {
    expect([...TIMELINE_TYPES]).toEqual(Object.values(TimelineType));
    expect([...REPORT_PLATFORMS]).toEqual(Object.values(Platform));
    expect(MAX_CHART_SERIES).toBe(8);
    expect(OTHER_SERIES_LABEL).toBe('Other');
  });
});

describe('day bucketing (the dailyRunActivity pattern)', () => {
  it('returns a fixed number of buckets ending on today, oldest first', () => {
    const keys = dayKeys(3, NOW);
    expect(keys).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(utcDay(daysAgo(1))).toBe('2026-09-25');
  });

  it('anchors cohort weeks to Monday', () => {
    expect(utcDay(isoWeekStart(new Date('2026-09-26T23:00:00Z')))).toBe('2026-09-21');
    expect(weeksBetween(new Date('2026-09-07T00:00:00Z'), new Date('2026-09-26T00:00:00Z'))).toBe(
      2,
    );
  });
});

describe('record_count', () => {
  it('counts every record as a scalar with no window to compare against', async () => {
    const r = await run({ source: 'record_count', objectTypeApiSlug: 'contact' });
    expect(r).toEqual({ shape: 'scalar', value: 4, previous: null, label: 'Contacts', unit: null });
  });

  it('honours the shared filter vocabulary', async () => {
    const r = await run({
      source: 'record_count',
      objectTypeApiSlug: 'contact',
      filters: [{ attribute: 'tier', op: 'eq', value: 'gold' }],
    });
    expect(r).toMatchObject({ shape: 'scalar', value: 2 });
  });

  it('groups by a SELECT attribute into x categories with one series', async () => {
    const r = (await run({
      source: 'record_count',
      objectTypeApiSlug: 'contact',
      groupByAttribute: 'tier',
    })) as SeriesResult;
    expect(r.shape).toBe('series');
    expect(r.xKind).toBe('category');
    expect(r.buckets.map((b) => b.label)).toEqual(['Gold', 'Silver']);
    expect(r.seriesKeys).toHaveLength(1);
    expect(r.values).toEqual([{ count: 2 }, { count: 1 }]);
  });

  it('buckets by UTC day of createdAt, zero-filled across the whole window', async () => {
    const r = (await run({
      source: 'record_count',
      objectTypeApiSlug: 'contact',
      byDay: true,
      days: 5,
    })) as SeriesResult;
    expect(r.buckets.map((b) => b.key)).toEqual(dayKeys(5, NOW));
    // 09-23 saw one person created, 09-25 saw two.
    expect(r.values.map((v) => v['count'])).toEqual([0, 1, 0, 2, 0]);
    expect(r.xKind).toBe('day');
  });

  it('crosses day with group to make a stackable result', async () => {
    const r = (await run({
      source: 'record_count',
      objectTypeApiSlug: 'contact',
      byDay: true,
      days: 4,
      groupByAttribute: 'tier',
    })) as SeriesResult;
    expect(r.seriesKeys.map((s) => s.label)).toEqual(['Gold', 'Silver', 'Not set']);
    // 3 days ago: one gold. 1 day ago: one gold, one silver.
    const gold = r.values.map((v) => v['gold']);
    expect(gold).toEqual([1, 0, 1, 0]);
  });

  it('refuses a widget pointed at an object or attribute that is gone', async () => {
    await expect(run({ source: 'record_count', objectTypeApiSlug: 'ghost' })).rejects.toThrow(
      /no longer exists/,
    );
    await expect(
      run({ source: 'record_count', objectTypeApiSlug: 'contact', groupByAttribute: 'ghost' }),
    ).rejects.toThrow(/not an attribute/);
  });
});

describe('timeline_count', () => {
  it('is a stat tile with a real previous window, not a chart', async () => {
    const r = await run({
      source: 'timeline_count',
      types: ['MESSAGE'],
      byDay: false,
      groupBy: 'none',
      days: 3,
    });
    // Messages in the last 3 days (today, −1, −2): today ×3, −2 ×1 = 4.
    // The 3 days before that (−3, −4, −5): one message on −4.
    expect(r).toEqual({ shape: 'scalar', value: 4, previous: 1, label: 'Messages', unit: null });
  });

  it('is the channel mix as a stacked bar: days on x, platforms as series', async () => {
    const r = (await run({
      source: 'timeline_count',
      groupBy: 'platform',
      byDay: true,
      days: 5,
    })) as SeriesResult;
    expect(r.buckets).toHaveLength(5);
    expect(r.seriesKeys.map((s) => s.key)).toEqual(['INSTAGRAM', 'LINKEDIN', ' unset']);
    expect(r.seriesKeys.map((s) => s.label)).toEqual(['INSTAGRAM', 'LINKEDIN', 'No platform']);
    expect(r.values.map((v) => v['INSTAGRAM'])).toEqual([0, 0, 1, 0, 2]);
    expect(r.values.map((v) => v['LINKEDIN'])).toEqual([0, 0, 1, 0, 1]);
    // Every series key exists in every bucket: zero-filled, so colours never shift.
    for (const bucket of r.values)
      expect(Object.keys(bucket).sort()).toEqual(r.seriesKeys.map((s) => s.key).sort());
  });

  it('orders platform series by the enum, never by size, so identity is stable', async () => {
    const r = (await run({
      source: 'timeline_count',
      groupBy: 'platform',
      byDay: true,
      days: 14,
    })) as SeriesResult;
    const order = r.seriesKeys.map((s) => s.key).filter((k) => k !== ' unset');
    expect(order).toEqual(['INSTAGRAM', 'LINKEDIN']);
    // INSTAGRAM has more events than LINKEDIN here, and would still be first if it had fewer.
  });

  it('drops byDay to put the groups on x with a single series', async () => {
    const r = (await run({
      source: 'timeline_count',
      groupBy: 'type',
      byDay: false,
      days: 14,
    })) as SeriesResult;
    expect(r.xKind).toBe('category');
    expect(r.seriesKeys).toHaveLength(1);
    expect(r.buckets.map((b) => b.label)).toEqual(['Messages', 'Comments']);
    expect(r.values).toEqual([{ count: 6 }, { count: 1 }]);
  });

  it('filters to one platform', async () => {
    const r = (await run({
      source: 'timeline_count',
      platforms: ['LINKEDIN'],
      byDay: true,
      days: 5,
    })) as SeriesResult;
    expect(r.values.reduce((n, v) => n + (v['count'] ?? 0), 0)).toBe(2);
  });
});

describe('sentiment_over_time', () => {
  it('averages positive/neutral/negative per UTC day and never invents a zero', async () => {
    const r = (await run({ source: 'sentiment_over_time', days: 5 })) as SeriesResult;
    expect(r.seriesKeys).toEqual([{ key: 'sentiment', label: 'Average sentiment' }]);
    const byDay = Object.fromEntries(r.buckets.map((b, i) => [b.key, r.values[i]!['sentiment']]));
    expect(byDay['2026-09-22']).toBe(0); // +1 and −1 on the same day
    expect(byDay['2026-09-24']).toBe(-1);
    // A day nobody measured has no point at all: the line breaks instead of reading "neutral".
    expect(byDay['2026-09-23']).toBeUndefined();
    expect(byDay['2026-09-26']).toBeUndefined();
  });

  it('ignores insights that are not conversation summaries', async () => {
    const r = (await run({ source: 'sentiment_over_time', days: 5 })) as SeriesResult;
    const i = r.buckets.findIndex((b) => b.key === '2026-09-23');
    expect(r.values[i]).toEqual({});
  });
});

describe('pipeline_funnel', () => {
  it("counts current entries per stage, in the list's own stage order", async () => {
    const r = await run({ source: 'pipeline_funnel', listId: pipelineListId });
    expect(r).toEqual({
      shape: 'funnel',
      valueLabel: 'Records in stage',
      steps: [
        { key: 'new', label: 'New', value: 2 },
        { key: 'active', label: 'Active', value: 0 },
        { key: 'won', label: 'Won', value: 1 },
      ],
    });
  });

  it('says so when the list is a collection or gone', async () => {
    await expect(run({ source: 'pipeline_funnel', listId: collectionListId })).rejects.toThrow(
      /not a pipeline/,
    );
    await expect(
      run({ source: 'pipeline_funnel', listId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe('record_table', () => {
  it('passes through to queryRecords with the chosen columns and labels option values', async () => {
    const r = await run({
      source: 'record_table',
      objectTypeApiSlug: 'contact',
      columns: ['name', 'tier'],
      sort: [{ attribute: 'createdAt', direction: 'asc' }],
      limit: 10,
    });
    expect(r.shape).toBe('table');
    if (r.shape !== 'table') throw new Error('unreachable');
    expect(r.columns.map((c) => c.label)).toEqual(['Name', 'Tier']);
    expect(r.rows.map((row) => row.cells)).toEqual([
      ['Edsger', null],
      ['Alan', 'Gold'],
      ['Ada', 'Gold'],
      ['Grace', 'Silver'],
    ]);
    expect(r.truncated).toBe(false);
  });

  it('marks a page that does not hold everything', async () => {
    const r = await run({ source: 'record_table', objectTypeApiSlug: 'contact', limit: 2 });
    expect(r.shape).toBe('table');
    if (r.shape !== 'table') throw new Error('unreachable');
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});

describe('cohort_retention', () => {
  it('leaves the future blank rather than calling it zero', async () => {
    const r = await run({ source: 'cohort_retention', objectTypeApiSlug: 'contact', weeks: 3 });
    expect(r.shape).toBe('matrix');
    if (r.shape !== 'matrix') throw new Error('unreachable');
    expect(r.rows).toHaveLength(3);
    expect(r.columns.map((c) => c.label)).toEqual(['+0w', '+1w', '+2w']);
    // The newest cohort can only have a +0w cell; everything past the present is null.
    expect(r.cells[2]![1]).toBeNull();
    expect(r.cells[2]![2]).toBeNull();
    expect(r.cells[1]![2]).toBeNull();
    for (const row of r.cells) {
      for (const cell of row) expect(cell === null || (cell >= 0 && cell <= 1)).toBe(true);
    }
  });

  it('scores a cohort member as retained in the week it was active', async () => {
    const r = await run({ source: 'cohort_retention', objectTypeApiSlug: 'contact', weeks: 3 });
    if (r.shape !== 'matrix') throw new Error('unreachable');
    // Edsger was created 10 days ago (week of 09-14, the first row) and had an event 9 days
    // ago — the same ISO week — so his cohort is 100% active at +0w.
    const first = r.rows.findIndex((row) => row.size > 0);
    expect(r.cells[first]![0]).toBe(1);
  });
});
