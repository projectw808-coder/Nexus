import { parseCsv, toCsv } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWorkspaces, type Seed } from './testing';

let seed: Seed;
let owner: ReturnType<Seed['caller']>;

beforeAll(async () => {
  seed = await seedWorkspaces();
  owner = seed.caller(seed.users.alice, 'acme');
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

describe('object & attribute admin', () => {
  it('protects system attributes and objects, and makes deletion reversible for 24h', async () => {
    const person = await owner.objectType.get({ objectType: 'person' });
    const email = person.attributes.find((a) => a.apiSlug === 'email')!;
    await expect(owner.attribute.delete({ id: email.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(owner.attribute.update({ id: email.id, apiSlug: 'mail' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(owner.objectType.delete({ id: person.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    // Title rename is allowed on system attributes.
    await owner.attribute.update({ id: email.id, title: 'E-mail address' });

    const custom = await owner.attribute.create({
      objectTypeId: person.id,
      apiSlug: 'nickname',
      title: 'Nickname',
      type: 'TEXT',
    });
    const del = await owner.attribute.delete({ id: custom.id });
    expect(del.restorableUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const afterDelete = await owner.objectType.get({ objectType: 'person' });
    expect(afterDelete.attributes.some((a) => a.id === custom.id)).toBe(false);
    expect(afterDelete.recentlyDeleted.map((a) => a.id)).toContain(custom.id);
    await owner.attribute.restore({ id: custom.id });
    expect(
      (await owner.objectType.get({ objectType: 'person' })).attributes.some(
        (a) => a.id === custom.id,
      ),
    ).toBe(true);
  });

  it('indexing is a dispatched job, never synchronous, and refuses non-indexable types', async () => {
    const person = await owner.objectType.get({ objectType: 'person' });
    const title = person.attributes.find((a) => a.apiSlug === 'title')!;
    const r = await owner.attribute.setIndexed({ id: title.id, indexed: true });
    expect(r.indexState).toBe('BUILDING');
    expect(seed.jobs.calls.at(-1)).toEqual({
      name: 'index.build',
      payload: { attributeId: title.id },
    });
    const loc = person.attributes.find((a) => a.apiSlug === 'location')!;
    await expect(owner.attribute.setIndexed({ id: loc.id, indexed: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const preview = await owner.attribute.migrationPreview({
      objectTypeId: person.id,
      type: 'NUMBER',
    });
    expect(preview).toMatchObject({ indexable: true, retentionHours: 24 });
  });

  it('field-level permissions apply in the serializer, on writes and in exports', async () => {
    const company = await owner.objectType.get({ objectType: 'company' });
    const industry = company.attributes.find((a) => a.apiSlug === 'industry')!;
    await owner.company.create({ values: { name: 'Initech', industry: 'Software' } });
    await owner.attribute.setPermission({
      attributeId: industry.id,
      role: 'VIEWER',
      access: 'HIDDEN',
    });
    await owner.attribute.setPermission({
      attributeId: industry.id,
      role: 'MEMBER',
      access: 'READ',
    });

    const viewer = seed.caller(seed.users.carol, 'acme');
    const q = await viewer.company.query({});
    expect(q.attributes.some((a) => a.id === industry.id)).toBe(false);
    expect(q.items.every((i) => !(industry.id in i.values))).toBe(true);

    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'MEMBER' },
      }),
    );
    const member = seed.caller(seed.users.carol, 'acme');
    const asMember = await member.company.query({});
    expect(asMember.attributes.find((a) => a.id === industry.id)?.access).toBe('READ');
    await expect(
      member.company.create({ values: { name: 'Nope', industry: 'x' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const exp = await owner.export.records({ objectType: 'company', format: 'csv' });
    const table = parseCsv(exp.body);
    expect(table.headers).toContain('industry');
    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'VIEWER' },
      }),
    );
    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'MEMBER' },
      }),
    );
    const memberExport = await seed
      .caller(seed.users.carol, 'acme')
      .export.records({ objectType: 'company', format: 'json' });
    expect((JSON.parse(memberExport.body) as Record<string, unknown>[])[0]).toHaveProperty(
      'industry',
    );
    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'VIEWER' },
      }),
    );
  });
});

describe('records, lists, views, search through the API', () => {
  it('creates a custom object, imports with preview and rollback, searches and exports', async () => {
    const ot = await owner.objectType.create({
      apiSlug: 'ticket',
      singular: 'Ticket',
      plural: 'Tickets',
    });
    await owner.attribute.create({
      objectTypeId: ot.id,
      apiSlug: 'priority',
      title: 'Priority',
      type: 'SELECT',
      config: {
        options: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ],
      },
    });
    await owner.attribute.create({
      objectTypeId: ot.id,
      apiSlug: 'points',
      title: 'Points',
      type: 'NUMBER',
    });

    const csv = toCsv(
      ['Name', 'Priority', 'Points'],
      [
        ['Login broken', 'High', '5'],
        ['Typo', 'Low', '1'],
        ['Bad', 'Urgent', 'x'],
      ],
    );
    const created = await owner.import.create({
      objectType: 'ticket',
      fileName: 'tickets.csv',
      csvText: csv,
    });
    expect(created.preview.stats).toEqual({ total: 3, valid: 2, invalid: 1 });
    expect(created.preview.unmappedHeaders).toEqual([]);
    const run = await owner.import.run({ id: created.id });
    expect(run).toMatchObject({ created: 2, failed: 1 });

    const list = await owner.record.query({
      objectType: 'ticket',
      query: {
        filters: [{ attribute: 'priority', op: 'eq', value: 'high' }],
        sort: [{ attribute: 'points', direction: 'desc' }],
        limit: 10,
        includeDeleted: false,
      },
    });
    expect(list.items.map((i) => i.label)).toEqual(['Login broken']);
    expect(list.total).toBe(1);

    const found = await owner.search.global({ q: 'typo' });
    expect(found.groups.map((g) => g.objectType.apiSlug)).toEqual(['ticket']);

    const exp = await owner.export.records({ objectType: 'ticket', format: 'csv' });
    expect(parseCsv(exp.body).rows.length).toBe(2);

    const rb = await owner.import.rollback({ id: created.id });
    expect(rb.removed).toBe(2);
    expect((await owner.record.query({ objectType: 'ticket' })).total).toBe(0);
    const jobs = await owner.import.list({ objectType: 'ticket' });
    expect(jobs[0]?.status).toBe('ROLLED_BACK');
  }, 120_000);

  it('a record sits in three pipelines with different stages, via the API', async () => {
    const deal = await owner.deal.create({ values: { name: 'Three pipes', amount: 500 } });
    const stages = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const lists = [];
    for (const name of ['X', 'Y', 'Z'])
      lists.push(await owner.list.create({ objectType: 'deal', name, kind: 'PIPELINE', stages }));
    await owner.listEntry.add({ listId: lists[0]!.id, recordId: deal.id, stage: 'a' });
    const e2 = await owner.listEntry.add({ listId: lists[1]!.id, recordId: deal.id, stage: 'b' });
    await owner.listEntry.add({ listId: lists[2]!.id, recordId: deal.id });
    await owner.listEntry.move({ entryId: e2.id, stage: 'a' });
    const detail = await owner.deal.get({ id: deal.id });
    expect(detail.lists.map((l) => [l.name, l.stage])).toEqual(
      expect.arrayContaining([
        ['X', 'a'],
        ['Y', 'a'],
        ['Z', 'a'],
      ]),
    );
    const board = await owner.list.get({ id: lists[1]!.id });
    expect(board.stages.map((s) => s.id)).toEqual(['a', 'b']);
    expect(board.entries[0]?.label).toBe('Three pipes');
    const history = await owner.listEntry.history({ entryId: e2.id });
    expect(history.map((h) => h.toStage)).toEqual(['a', 'b']);
    await expect(
      owner.list.update({ id: lists[1]!.id, stages: [{ id: 'b', label: 'B' }] }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('views are private unless an admin shares them', async () => {
    const person = await owner.objectType.get({ objectType: 'person' });
    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'MEMBER' },
      }),
    );
    const member = seed.caller(seed.users.carol, 'acme');
    const mine = await member.view.create({
      objectTypeId: person.id,
      name: 'Mine',
      filters: [{ attribute: 'name', op: 'contains', value: 'a' }],
    });
    await expect(
      member.view.create({ objectTypeId: person.id, name: 'Shared', isShared: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await owner.view.list({ objectTypeId: person.id })).some((v) => v.id === mine.id)).toBe(
      false,
    );
    const shared = await owner.view.create({
      objectTypeId: person.id,
      name: 'Everyone',
      isShared: true,
    });
    expect((await member.view.list({ objectTypeId: person.id })).map((v) => v.id)).toEqual(
      expect.arrayContaining([mine.id, shared.id]),
    );
    await expect(member.view.update({ id: shared.id, name: 'Hijack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await seed.db.runtime.withSystem((s) =>
      s.membership.updateMany({
        where: { workspaceId: seed.acme.id, userId: seed.users.carol.id },
        data: { role: 'VIEWER' },
      }),
    );
  });
});
