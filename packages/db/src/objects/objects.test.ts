import { toCsv } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../scoped.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { attributeAccess, loadAttributes, redactValues, type AttributeRow } from './attributes.ts';
import { previewImport, rollbackImport, runImport } from './imports.ts';
import { runIndexBuild } from './indexing.ts';
import { addEntry, createList, moveEntry } from './lists.ts';
import { countRecords, createRecord, queryRecords, updateRecord } from './records.ts';

let db: TestDatabase;
let actor: Actor;
let ws: { id: string; slug: string };
let user: string;

const ALL_TYPES = [
  ['text', 'TEXT', {}],
  ['number', 'NUMBER', {}],
  ['amount', 'CURRENCY', { currency: 'EUR' }],
  ['date', 'DATE', {}],
  ['datetime', 'DATETIME', {}],
  [
    'select',
    'SELECT',
    {
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  ],
  [
    'multi',
    'MULTISELECT',
    {
      options: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
    },
  ],
  ['flag', 'BOOLEAN', {}],
  ['email', 'EMAIL', {}],
  ['phone', 'PHONE', {}],
  ['url', 'URL', {}],
  ['rating', 'RATING', { max: 5 }],
] as const;

let objectTypeId: string;
let attrs: AttributeRow[];
const A = (slug: string) => attrs.find((a) => a.apiSlug === slug)!;

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@acme.test', name: 'Owner' } });
  user = u.id;
  ws = await db.tenancy.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: user });
  actor = { workspaceId: ws.id, userId: user, role: 'OWNER', grants: [] };

  objectTypeId = await db.runtime.withTenant(actor, async (t) => {
    const ot = await t.objectType.create({
      data: { workspaceId: ws.id, apiSlug: 'widget', singular: 'Widget', plural: 'Widgets' },
    });
    let position = 0;
    for (const [slug, type, config] of ALL_TYPES) {
      await t.attribute.create({
        data: {
          workspaceId: ws.id,
          objectTypeId: ot.id,
          apiSlug: slug,
          title: slug,
          type,
          config,
          isRequired: slug === 'text',
          isUnique: slug === 'email',
          position: position++,
        },
      });
    }
    return ot.id;
  });
  attrs = await db.runtime.withTenant(actor, (t) => loadAttributes(t, objectTypeId));
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('system objects', () => {
  it('backfills a pre-Phase-2 workspace once and never twice', async () => {
    const u = await db.prisma.user.create({ data: { email: 'old@acme.test', name: 'Old' } });
    const old = await db.tenancy.createWorkspace({ name: 'Old', slug: 'old', ownerUserId: u.id });
    await db.runtime.withSystem((s) => s.objectType.deleteMany({ where: { workspaceId: old.id } }));
    expect(await db.tenancy.ensureSystemObjects(old.id)).toBe(true);
    expect(await db.tenancy.ensureSystemObjects(old.id)).toBe(false);
    const n = await db.runtime.withSystem((s) =>
      s.objectType.count({ where: { workspaceId: old.id, isSystem: true } }),
    );
    expect(n).toBe(3);
  });

  it('seeds Person, Company, Deal and a Sales pipeline into a new workspace', async () => {
    const types = await db.runtime.withTenant(actor, (t) =>
      t.objectType.findMany({ where: { isSystem: true }, orderBy: { apiSlug: 'asc' } }),
    );
    expect(types.map((x) => x.apiSlug)).toEqual(['company', 'deal', 'person']);
    const person = types.find((x) => x.apiSlug === 'person')!;
    const personAttrs = await db.runtime.withTenant(actor, (t) => loadAttributes(t, person.id));
    expect(personAttrs.filter((a) => a.isSystem).map((a) => a.apiSlug)).toEqual(
      expect.arrayContaining(['name', 'email', 'phone']),
    );
    const lists = await db.runtime.withTenant(actor, (t) =>
      t.list.findMany({ where: { kind: 'PIPELINE' } }),
    );
    expect(lists.map((l) => l.name)).toEqual(['Sales pipeline']);
  });
});

describe('records', () => {
  it('creates a record across twelve attribute types, enforces required and unique, syncs relations', async () => {
    const created = await db.runtime.withTenant(actor, (t) =>
      createRecord(t, actor, {
        objectTypeId,
        attributes: attrs,
        input: {
          text: 'first',
          number: 12,
          amount: 99.5,
          date: '2026-01-31',
          datetime: '2026-01-31T10:00:00Z',
          select: 'a',
          multi: ['x'],
          flag: true,
          email: 'One@Example.com',
          phone: '+14155550001',
          url: 'https://example.com',
          rating: 3,
        },
      }),
    );
    expect(created.values[A('email').id]).toBe('one@example.com');
    await expect(
      db.runtime.withTenant(actor, (t) =>
        createRecord(t, actor, { objectTypeId, attributes: attrs, input: { number: 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      db.runtime.withTenant(actor, (t) =>
        createRecord(t, actor, {
          objectTypeId,
          attributes: attrs,
          input: { text: 'dup', email: 'ONE@example.com' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const upd = await db.runtime.withTenant(actor, (t) =>
      updateRecord(t, actor, {
        recordId: created.id,
        attributes: attrs,
        input: { number: 13, select: null },
      }),
    );
    expect(upd.after.values[A('number').id]).toBe(13);
    expect(A('select').id in upd.after.values).toBe(false);
  });

  it('field-level permissions hide and protect attributes', async () => {
    await db.runtime.withTenant(actor, (t) =>
      t.attributePermission.create({
        data: { workspaceId: ws.id, attributeId: A('amount').id, role: 'MEMBER', access: 'HIDDEN' },
      }),
    );
    const fresh = await db.runtime.withTenant(actor, (t) => loadAttributes(t, objectTypeId));
    const member: Actor = { ...actor, role: 'MEMBER' };
    expect(
      attributeAccess(
        member,
        fresh.find((a) => a.apiSlug === 'amount')!,
      ),
    ).toBe('HIDDEN');
    expect(
      attributeAccess(
        { role: 'VIEWER' },
        fresh.find((a) => a.apiSlug === 'text')!,
      ),
    ).toBe('READ');
    const red = redactValues(member, fresh, {
      [A('amount').id]: 5,
      [A('text').id]: 'x',
      _unmapped: { a: 1 },
    });
    expect(red).toEqual({ [A('text').id]: 'x' });
    await expect(
      db.runtime.withTenant(member, (t) =>
        createRecord(t, member, {
          objectTypeId,
          attributes: fresh,
          input: { text: 'm', amount: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.runtime.withTenant(actor, (t) =>
      t.attributePermission.deleteMany({ where: { attributeId: A('amount').id } }),
    );
  });

  it('filters, sorts, paginates by cursor and searches', async () => {
    await db.runtime.withTenant(actor, async (t) => {
      for (let i = 0; i < 25; i++) {
        await createRecord(t, actor, {
          objectTypeId,
          attributes: attrs,
          input: {
            text: `item ${i.toString().padStart(2, '0')}`,
            number: i,
            select: i % 2 ? 'a' : 'b',
            multi: i % 3 ? ['x'] : ['y'],
            flag: i > 20,
          },
        });
      }
    });
    const page1 = await db.runtime.withTenant(actor, (t) =>
      queryRecords(t, {
        workspaceId: ws.id,
        objectTypeId,
        attributes: attrs,
        query: {
          filters: [{ attribute: 'select', op: 'eq', value: 'a' }],
          sort: [{ attribute: 'number', direction: 'desc' }],
          limit: 5,
          includeDeleted: false,
        },
      }),
    );
    expect(page1.items.map((r) => r.values[A('number').id])).toEqual([23, 21, 19, 17, 15]);
    const page2 = await db.runtime.withTenant(actor, (t) =>
      queryRecords(t, {
        workspaceId: ws.id,
        objectTypeId,
        attributes: attrs,
        query: {
          filters: [{ attribute: 'select', op: 'eq', value: 'a' }],
          sort: [{ attribute: 'number', direction: 'desc' }],
          limit: 5,
          cursor: page1.nextCursor!,
          includeDeleted: false,
        },
      }),
    );
    expect(page2.items.map((r) => r.values[A('number').id])).toEqual([13, 11, 9, 7, 5]);

    const between = await db.runtime.withTenant(actor, (t) =>
      countRecords(t, {
        workspaceId: ws.id,
        objectTypeId,
        attributes: attrs,
        filters: [
          { attribute: 'number', op: 'gte', value: 10 },
          { attribute: 'number', op: 'lt', value: 20 },
        ],
      }),
    );
    expect(between).toBe(11); // 10 seeded in range + the first record (number 13)
    const hasY = await db.runtime.withTenant(actor, (t) =>
      countRecords(t, {
        workspaceId: ws.id,
        objectTypeId,
        attributes: attrs,
        filters: [{ attribute: 'multi', op: 'hasAny', value: ['y'] }],
      }),
    );
    expect(hasY).toBe(9);
    const found = await db.runtime.withTenant(actor, (t) =>
      queryRecords(t, {
        workspaceId: ws.id,
        objectTypeId,
        attributes: attrs,
        query: { filters: [], sort: [], search: 'item 07', limit: 10, includeDeleted: false },
      }),
    );
    expect(found.items.map((r) => r.values[A('text').id])).toEqual(['item 07']);
    await expect(
      db.runtime.withTenant(actor, (t) =>
        queryRecords(t, {
          workspaceId: ws.id,
          objectTypeId,
          attributes: attrs,
          query: {
            filters: [{ attribute: 'flag', op: 'contains', value: 't' }],
            sort: [],
            limit: 10,
            includeDeleted: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('lists', () => {
  it('a record sits in three pipelines with different stage values in each', async () => {
    const dealType = await db.runtime.withTenant(actor, (t) =>
      t.objectType.findFirstOrThrow({ where: { apiSlug: 'deal' } }),
    );
    const dealAttrs = await db.runtime.withTenant(actor, (t) => loadAttributes(t, dealType.id));
    const deal = await db.runtime.withTenant(actor, (t) =>
      createRecord(t, actor, {
        objectTypeId: dealType.id,
        attributes: dealAttrs,
        input: { name: 'Big deal', amount: 1000, stage: 'lead' },
      }),
    );
    const stages = [
      { id: 's1', label: 'One' },
      { id: 's2', label: 'Two' },
      { id: 's3', label: 'Three' },
    ];
    const listIds: string[] = [];
    for (const name of ['P1', 'P2', 'P3']) {
      const l = await db.runtime.withTenant(actor, (t) =>
        createList(t, actor, { objectTypeId: dealType.id, name, kind: 'PIPELINE', stages }),
      );
      listIds.push(l.id);
    }
    const entries = await db.runtime.withTenant(actor, async (t) => [
      await addEntry(t, actor, { listId: listIds[0]!, recordId: deal.id, stage: 's1' }),
      await addEntry(t, actor, { listId: listIds[1]!, recordId: deal.id, stage: 's2' }),
      await addEntry(t, actor, { listId: listIds[2]!, recordId: deal.id, stage: 's3' }),
    ]);
    expect(entries.map((e) => e.stage)).toEqual(['s1', 's2', 's3']);
    await expect(
      db.runtime.withTenant(actor, (t) =>
        addEntry(t, actor, { listId: listIds[0]!, recordId: deal.id }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const moved = await db.runtime.withTenant(actor, (t) =>
      moveEntry(t, actor, { entryId: entries[0]!.id, stage: 's3' }),
    );
    expect(moved.stage).toBe('s3');
    const history = await db.runtime.withTenant(actor, (t) =>
      t.listStageHistory.findMany({
        where: { listEntryId: entries[0]!.id },
        orderBy: { at: 'asc' },
      }),
    );
    expect(history.map((h) => [h.fromStage, h.toStage])).toEqual([
      [null, 's1'],
      ['s1', 's3'],
    ]);
    const stagesNow = await db.runtime.withTenant(actor, (t) =>
      t.listEntry.findMany({
        where: { recordId: deal.id },
        orderBy: { createdAt: 'asc' },
        select: { stage: true },
      }),
    );
    expect(stagesNow.map((e) => e.stage)).toEqual(['s3', 's2', 's3']);
  });

  it('orders entries with fractional positions and rebalances when precision runs out', async () => {
    const dealType = await db.runtime.withTenant(actor, (t) =>
      t.objectType.findFirstOrThrow({ where: { apiSlug: 'deal' } }),
    );
    const dealAttrs = await db.runtime.withTenant(actor, (t) => loadAttributes(t, dealType.id));
    const list = await db.runtime.withTenant(actor, (t) =>
      createList(t, actor, {
        objectTypeId: dealType.id,
        name: 'Order',
        kind: 'PIPELINE',
        stages: [{ id: 'o', label: 'O' }],
      }),
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await db.runtime.withTenant(actor, (t) =>
        createRecord(t, actor, {
          objectTypeId: dealType.id,
          attributes: dealAttrs,
          input: { name: `d${i}` },
        }),
      );
      const e = await db.runtime.withTenant(actor, (t) =>
        addEntry(t, actor, { listId: list.id, recordId: r.id }),
      );
      ids.push(e.id);
    }
    // Move the third between the first and the second, repeatedly, until precision is exhausted.
    let rebalanced = false;
    for (let i = 0; i < 60 && !rebalanced; i++) {
      const order = await db.runtime.withTenant(actor, (t) =>
        t.listEntry.findMany({
          where: { listId: list.id, deletedAt: null },
          orderBy: { position: 'asc' },
          select: { id: true },
        }),
      );
      const [first, second] = order.map((o) => o.id);
      const last = order[2]!.id;
      const m = await db.runtime.withTenant(actor, (t) =>
        moveEntry(t, actor, { entryId: last, afterEntryId: first, beforeEntryId: second }),
      );
      rebalanced = m.rebalanced;
    }
    expect(rebalanced).toBe(true);
    const positions = await db.runtime.withTenant(actor, (t) =>
      t.listEntry.findMany({
        where: { listId: list.id, deletedAt: null },
        orderBy: { position: 'asc' },
        select: { position: true },
      }),
    );
    expect(positions.length).toBe(3);
    expect(positions[2]!.position - positions[0]!.position).toBeGreaterThan(1);
  });
});

describe('import', () => {
  it('previews, imports 10k rows and rolls them back', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [
      `Imported ${i}`,
      String(i),
      i % 2 ? 'A' : 'B',
      `imp${i}@example.com`,
    ]);
    rows[5] = ['Bad row', 'not-a-number', 'A', 'bad5@example.com'];
    const csv = toCsv(['Text', 'Number', 'Select', 'Email'], rows);
    const preview = previewImport(
      csv,
      ',',
      attrs.map((a) => ({
        id: a.id,
        apiSlug: a.apiSlug,
        title: a.title,
        type: a.type,
        config: a.config as Record<string, unknown>,
        isRequired: a.isRequired,
        isUnique: a.isUnique,
        isSystem: a.isSystem,
      })),
    );
    expect(preview.stats).toEqual({ total: 10_000, valid: 9_999, invalid: 1 });
    expect(preview.errors[0]).toMatchObject({ row: 7, column: 'Number' });
    expect(preview.mapping['Email']).toEqual({ attributeId: A('email').id });

    const job = await db.runtime.withTenant(actor, (t) =>
      t.importJob.create({
        data: {
          workspaceId: ws.id,
          objectTypeId,
          createdById: user,
          fileName: 'widgets.csv',
          sourceText: csv,
          mapping: preview.mapping,
        },
      }),
    );
    const before = await db.runtime.withTenant(actor, (t) =>
      t.record.count({ where: { objectTypeId, deletedAt: null } }),
    );
    const stats = await runImport(db.runtime, actor, job.id);
    expect(stats.created).toBe(9_999);
    expect(stats.failed).toBe(1);
    const after = await db.runtime.withTenant(actor, (t) =>
      t.record.count({ where: { objectTypeId, deletedAt: null } }),
    );
    expect(after - before).toBe(9_999);

    const rb = await db.runtime.withTenant(actor, (t) => rollbackImport(t, job.id));
    expect(rb.removed).toBe(9_999);
    const restored = await db.runtime.withTenant(actor, (t) =>
      t.record.count({ where: { objectTypeId, deletedAt: null } }),
    );
    expect(restored).toBe(before);
    const jobRow = await db.runtime.withTenant(actor, (t) =>
      t.importJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect(jobRow.status).toBe('ROLLED_BACK');
  }, 600_000);
});

describe('generated-column index', () => {
  it('builds the index for a hot attribute over 100k records and keeps filter+sort under 200 ms p95', async () => {
    // Seed 100k rows straight in SQL (as superuser) — this measures our pipeline, not the ORM.
    await db.sqlAsSuperuser(
      `INSERT INTO "Record" ("id","workspaceId","objectTypeId","values","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, $2,
              jsonb_build_object($3::text, 'seed ' || g, $4::text, (g % 1000)::text, $5::text, CASE WHEN g % 2 = 0 THEN 'a' ELSE 'b' END),
              now(), now()
       FROM generate_series(1, 100000) g`,
      [ws.id, objectTypeId, A('text').id, A('number').id, A('select').id],
    );
    const total = await db.runtime.withTenant(actor, (t) =>
      t.record.count({ where: { objectTypeId } }),
    );
    expect(total).toBeGreaterThanOrEqual(100_000);

    const run = async () => {
      const fresh = await db.runtime.withTenant(actor, (t) => loadAttributes(t, objectTypeId));
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        await db.runtime.withTenant(actor, (t) =>
          queryRecords(t, {
            workspaceId: ws.id,
            objectTypeId,
            attributes: fresh,
            query: {
              filters: [{ attribute: 'number', op: 'gte', value: 900 }],
              sort: [{ attribute: 'number', direction: 'desc' }],
              limit: 50,
              includeDeleted: false,
            },
          }),
        );
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return {
        p95: samples[Math.floor(samples.length * 0.95) - 1]!,
        median: samples[Math.floor(samples.length / 2)]!,
      };
    };

    const before = await run();
    await runIndexBuild(db.runtime, A('number').id);
    const attr = await db.runtime.withSystem((s) =>
      s.attribute.findUniqueOrThrow({ where: { id: A('number').id } }),
    );
    expect(attr.indexState).toBe('READY');
    const cols = await db.sqlAsSuperuser(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Record' AND column_name LIKE 'gen_%'`,
    );
    expect(cols.length).toBe(1);
    const after = await run();
    // eslint-disable-next-line no-console
    console.log(
      `filter+sort over ${total} rows: before index p95=${before.p95.toFixed(1)}ms median=${before.median.toFixed(1)}ms; after p95=${after.p95.toFixed(1)}ms median=${after.median.toFixed(1)}ms`,
    );
    expect(after.p95).toBeLessThan(200);

    // The trigger keeps the column current for new writes.
    const rec = await db.runtime.withTenant(actor, (t) =>
      createRecord(t, actor, {
        objectTypeId,
        attributes: attrs,
        input: { text: 'trigger', number: 424242 },
      }),
    );
    const col = (await db.sqlAsSuperuser(
      `SELECT "gen_${A('number').id.replace(/-/g, '')}"::text AS v FROM "Record" WHERE id = $1`,
      [rec.id],
    )) as { v: string }[];
    expect(col[0]?.v).toBe('424242');
  }, 900_000);
});
