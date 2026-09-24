/**
 * Phase 1 acceptance, generated from the router manifest so a new route cannot be forgotten:
 *
 *  1. Cross-tenant isolation: a user who is not a member of workspace A gets NOT_FOUND on every
 *     tenant procedure addressed to A, and a member of B addressing B with A's ids gets
 *     NOT_FOUND — never A's data.
 *  2. A `viewer` cannot mutate anything.
 *  3. Every mutation writes an audit row.
 *
 * Every procedure must have an entry in FIXTURES; the first test fails otherwise.
 */
import { toCsv } from '@nexus/core';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callPath, procedureManifest, seedWorkspaces, type Seed } from './testing';

type Tier = 'public' | 'user' | 'tenant';
type Fixture = {
  tier: Tier;
  /** Valid input for the owner of Acme; `ids` are Acme's rows, refreshed before each call. */
  input: (ids: Ids) => unknown;
  /** Input that references Acme rows but is sent to Globex (cross-tenant by id). */
  crossInput?: (ids: Ids) => unknown;
  /** Reason a user-tier mutation writes its audit row inside packages/db instead of ctx.audit. */
  auditedBy?: 'tenancy';
  /** Expected code for a member of B using A's ids (default NOT_FOUND). */
  crossExpect?: string;
};

type Ids = {
  carolMembershipId: string;
  invitationId: string;
  auditCursor: string | undefined;
  objectTypeId: string;
  attributeId: string;
  recordId: string;
  listId: string;
  entryId: string;
  viewId: string;
  importJobId: string;
  spareRecordId: string;
  noteId: string;
  taskId: string;
  personId: string;
  companyId: string;
  dealId: string;
};

const FIXTURES: Record<string, Fixture> = {
  'me.get': { tier: 'user', input: () => undefined },
  'workspace.list': { tier: 'user', input: () => undefined },
  'workspace.create': {
    tier: 'user',
    input: () => ({ name: 'Initech', slug: `initech-${Date.now()}` }),
    auditedBy: 'tenancy',
  },
  'workspace.current': { tier: 'tenant', input: () => undefined },
  'workspace.update': { tier: 'tenant', input: () => ({ name: 'Acme Corp' }) },
  'member.list': { tier: 'tenant', input: () => undefined },
  'member.changeRole': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
  },
  'member.remove': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId }),
  },
  'invitation.list': { tier: 'tenant', input: () => undefined },
  'invitation.create': {
    tier: 'tenant',
    input: () => ({ email: `new-${Date.now()}@acme.test`, role: 'MEMBER' }),
  },
  'invitation.revoke': {
    tier: 'tenant',
    input: (ids) => ({ invitationId: ids.invitationId }),
    crossInput: (ids) => ({ invitationId: ids.invitationId }),
  },
  'invitation.preview': { tier: 'public', input: () => ({ token: 'x'.repeat(32) }) },
  'invitation.accept': {
    tier: 'user',
    input: () => ({ token: 'x'.repeat(32) }),
    auditedBy: 'tenancy',
  },
  'audit.list': { tier: 'tenant', input: (ids) => ({ limit: 10, cursor: ids.auditCursor }) },
  // ── Phase 2 ─────────────────────────────────────────────────────────────
  'objectType.list': { tier: 'tenant', input: () => undefined },
  'objectType.get': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'objectType.create': {
    tier: 'tenant',
    input: () => ({ apiSlug: `obj_${Date.now()}`, singular: 'Thing', plural: 'Things' }),
  },
  'objectType.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.objectTypeId, singular: 'Widget!' }),
    crossInput: (ids) => ({ id: ids.objectTypeId, singular: 'Pwned' }),
  },
  'objectType.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.objectTypeId }),
    crossInput: (ids) => ({ id: ids.objectTypeId }),
  },
  'attribute.list': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'attribute.migrationPreview': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, type: 'TEXT' }),
  },
  'attribute.create': {
    tier: 'tenant',
    input: (ids) => ({
      objectTypeId: ids.objectTypeId,
      apiSlug: `a_${Date.now()}`,
      title: 'A',
      type: 'TEXT',
    }),
    crossInput: (ids) => ({
      objectTypeId: ids.objectTypeId,
      apiSlug: 'pwned',
      title: 'P',
      type: 'TEXT',
    }),
  },
  'attribute.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId, title: 'Renamed' }),
    crossInput: (ids) => ({ id: ids.attributeId, title: 'Pwned' }),
  },
  'attribute.setIndexed': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId, indexed: true }),
    crossInput: (ids) => ({ id: ids.attributeId, indexed: true }),
  },
  'attribute.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId }),
    crossInput: (ids) => ({ id: ids.attributeId }),
  },
  'attribute.restore': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId }),
    crossInput: (ids) => ({ id: ids.attributeId }),
  },
  'attribute.reorder': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, ids: [ids.attributeId] }),
  },
  'attribute.setPermission': {
    tier: 'tenant',
    input: (ids) => ({ attributeId: ids.attributeId, role: 'MEMBER', access: 'READ' }),
    crossInput: (ids) => ({ attributeId: ids.attributeId, role: 'MEMBER', access: 'HIDDEN' }),
  },
  'record.query': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'record.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.recordId }),
    crossInput: (ids) => ({ id: ids.recordId }),
  },
  'record.create': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', values: { name: 'New' } }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, values: { name: 'Pwned' } }),
  },
  'record.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.recordId, values: { name: 'Updated' } }),
    crossInput: (ids) => ({ id: ids.recordId, values: { name: 'Pwned' } }),
  },
  'record.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.recordId] }) },
  'record.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.recordId] }) },
  'person.query': { tier: 'tenant', input: () => ({}) },
  'person.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.personId }),
    crossInput: (ids) => ({ id: ids.personId }),
  },
  'person.create': { tier: 'tenant', input: () => ({ values: { name: 'Pat' } }) },
  'person.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.personId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.personId, values: { name: 'Pwned' } }),
  },
  'person.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.personId] }) },
  'person.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.personId] }) },
  'company.query': { tier: 'tenant', input: () => ({}) },
  'company.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.companyId }),
    crossInput: (ids) => ({ id: ids.companyId }),
  },
  'company.create': { tier: 'tenant', input: () => ({ values: { name: 'Co' } }) },
  'company.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.companyId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.companyId, values: { name: 'Pwned' } }),
  },
  'company.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.companyId] }) },
  'company.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.companyId] }) },
  'deal.query': { tier: 'tenant', input: () => ({}) },
  'deal.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.dealId }),
    crossInput: (ids) => ({ id: ids.dealId }),
  },
  'deal.create': { tier: 'tenant', input: () => ({ values: { name: 'D' } }) },
  'deal.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.dealId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.dealId, values: { name: 'Pwned' } }),
  },
  'deal.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.dealId] }) },
  'deal.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.dealId] }) },
  'list.list': { tier: 'tenant', input: () => ({}) },
  'list.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId }),
    crossInput: (ids) => ({ id: ids.listId }),
  },
  'list.create': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', name: 'L', kind: 'COLLECTION' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, name: 'Pwned', kind: 'COLLECTION' }),
  },
  'list.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId, name: 'L2' }),
    crossInput: (ids) => ({ id: ids.listId, name: 'Pwned' }),
  },
  'list.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId }),
    crossInput: (ids) => ({ id: ids.listId }),
  },
  'listEntry.add': {
    tier: 'tenant',
    input: (ids) => ({ listId: ids.listId, recordId: ids.spareRecordId }),
    crossInput: (ids) => ({ listId: ids.listId, recordId: ids.spareRecordId }),
  },
  'listEntry.move': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId, stage: 's2' }),
    crossInput: (ids) => ({ entryId: ids.entryId, stage: 's2' }),
  },
  'listEntry.update': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId, values: {} }),
    crossInput: (ids) => ({ entryId: ids.entryId, values: {} }),
  },
  'listEntry.remove': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId }),
    crossInput: (ids) => ({ entryId: ids.entryId }),
  },
  'listEntry.history': { tier: 'tenant', input: (ids) => ({ entryId: ids.entryId }) },
  'view.list': { tier: 'tenant', input: () => ({}) },
  'view.create': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, name: 'V' }),
  },
  'view.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.viewId, name: 'V2' }),
    crossInput: (ids) => ({ id: ids.viewId, name: 'Pwned' }),
  },
  'view.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.viewId }),
    crossInput: (ids) => ({ id: ids.viewId }),
  },
  'search.global': { tier: 'tenant', input: () => ({ q: 'widget' }) },
  'import.list': { tier: 'tenant', input: () => ({}) },
  'import.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.create': {
    tier: 'tenant',
    input: () => ({
      objectType: 'widget',
      fileName: 'w.csv',
      csvText: toCsv(['name'], [['a'], ['b']]),
    }),
    crossInput: (ids) => ({
      objectType: ids.objectTypeId,
      fileName: 'p.csv',
      csvText: 'name\npwned\n',
    }),
  },
  'import.preview': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.run': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.rollback': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
    crossExpect: 'NOT_FOUND',
  },
  'record.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.recordId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.recordId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'record.history': { tier: 'tenant', input: (ids) => ({ id: ids.recordId }) },
  'listEntry.addMany': {
    tier: 'tenant',
    input: (ids) => ({ listId: ids.listId, recordIds: [ids.spareRecordId] }),
    crossInput: (ids) => ({ listId: ids.listId, recordIds: [ids.spareRecordId] }),
  },
  'note.list': { tier: 'tenant', input: (ids) => ({ recordId: ids.recordId }) },
  'note.create': {
    tier: 'tenant',
    input: (ids) => ({ recordId: ids.recordId, body: 'hello' }),
    crossInput: (ids) => ({ recordId: ids.recordId, body: 'pwned' }),
  },
  'note.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.noteId, pinned: true }),
    crossInput: (ids) => ({ id: ids.noteId, body: 'pwned' }),
  },
  'note.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.noteId }),
    crossInput: (ids) => ({ id: ids.noteId }),
  },
  'task.list': { tier: 'tenant', input: (ids) => ({ recordId: ids.recordId }) },
  'task.create': {
    tier: 'tenant',
    input: (ids) => ({ recordId: ids.recordId, title: 'Call' }),
    crossInput: (ids) => ({ recordId: ids.recordId, title: 'pwned' }),
  },
  'task.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.taskId, status: 'DONE' }),
    crossInput: (ids) => ({ id: ids.taskId, title: 'pwned' }),
  },
  'task.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.taskId }),
    crossInput: (ids) => ({ id: ids.taskId }),
  },
  'person.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.personId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.personId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'person.history': { tier: 'tenant', input: (ids) => ({ id: ids.personId }) },
  'company.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.companyId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.companyId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'company.history': { tier: 'tenant', input: (ids) => ({ id: ids.companyId }) },
  'deal.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.dealId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.dealId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'deal.history': { tier: 'tenant', input: (ids) => ({ id: ids.dealId }) },
  'export.records': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', format: 'csv' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, format: 'csv' }),
  },
};

let seed: Seed;
let widgetTypeId: string;

async function freshIds(): Promise<Ids> {
  // Re-seed the rows mutations consume so each test starts from a known state.
  const carol = await seed.db.runtime.withSystem(async (s) => {
    const m = await s.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: seed.acme.id, userId: seed.users.carol.id } },
    });
    return m
      ? s.membership.update({ where: { id: m.id }, data: { deletedAt: null, role: 'VIEWER' } })
      : s.membership.create({
          data: { workspaceId: seed.acme.id, userId: seed.users.carol.id, role: 'VIEWER' },
        });
  });
  const owner = seed.caller(seed.users.alice, 'acme');
  const inv = await owner.invitation.create({
    email: `pending-${Date.now()}-${Math.random()}@acme.test`,
    role: 'VIEWER',
  });
  await seed.db.runtime.withSystem(async (s) => {
    await s.objectType.updateMany({ where: { id: widgetTypeId }, data: { deletedAt: null } });
    await s.attribute.updateMany({
      where: { objectTypeId: widgetTypeId, isSystem: true },
      data: { deletedAt: null, purgeAfter: null },
    });
  });
  const attr = await owner.attribute.create({
    objectTypeId: widgetTypeId,
    apiSlug: `f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    title: 'Field',
    type: 'TEXT',
  });
  const rec = await owner.record.create({
    objectType: 'widget',
    values: { name: `rec ${Date.now()}` },
  });
  const list = await owner.list.create({
    objectType: 'widget',
    name: 'Pipe',
    kind: 'PIPELINE',
    stages: [
      { id: 's1', label: 'One' },
      { id: 's2', label: 'Two' },
    ],
  });
  const entry = await owner.listEntry.add({ listId: list.id, recordId: rec.id });
  const view = await owner.view.create({ objectTypeId: widgetTypeId, name: 'Mine' });
  const job = await owner.import.create({
    objectType: 'widget',
    fileName: 'w.csv',
    csvText: toCsv(['name'], [['imported one']]),
  });
  const spare = await owner.record.create({
    objectType: 'widget',
    values: { name: `spare ${Date.now()}` },
  });
  const note = await owner.note.create({ recordId: rec.id, body: 'first note' });
  const task = await owner.task.create({ recordId: rec.id, title: 'follow up' });
  const person = await owner.person.create({ values: { name: 'Pat' } });
  const company = await owner.company.create({ values: { name: 'Acme Co' } });
  const deal = await owner.deal.create({ values: { name: 'Deal' } });
  return {
    spareRecordId: spare.id,
    noteId: note.id,
    taskId: task.id,
    personId: person.id,
    companyId: company.id,
    dealId: deal.id,
    carolMembershipId: carol.id,
    invitationId: inv.id,
    auditCursor: undefined,
    objectTypeId: widgetTypeId,
    attributeId: attr.id,
    recordId: rec.id,
    listId: list.id,
    entryId: entry.id,
    viewId: view.id,
    importJobId: job.id,
  };
}

const codeOf = (e: unknown): string =>
  e instanceof TRPCError ? e.code : `not-a-TRPCError: ${String(e)}`;

beforeAll(async () => {
  seed = await seedWorkspaces();
  const owner = seed.caller(seed.users.alice, 'acme');
  const ot = await owner.objectType.create({
    apiSlug: 'widget',
    singular: 'Widget',
    plural: 'Widgets',
  });
  widgetTypeId = ot.id;
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

describe('router manifest', () => {
  it('every procedure has an isolation fixture', () => {
    const missing = procedureManifest()
      .map((p) => p.path)
      .filter((p) => !(p in FIXTURES));
    expect(missing, `add fixtures in server/isolation.test.ts for: ${missing.join(', ')}`).toEqual(
      [],
    );
    const stale = Object.keys(FIXTURES).filter(
      (p) => !procedureManifest().some((m) => m.path === p),
    );
    expect(stale, `fixtures for removed procedures: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('cross-tenant isolation', () => {
  const tenantProcs = () => procedureManifest().filter((p) => FIXTURES[p.path]?.tier === 'tenant');

  it('a non-member addressing workspace A gets NOT_FOUND on every tenant procedure', async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const bobOnAcme = seed.caller(seed.users.bob, 'acme');
      const result = await callPath(bobOnAcme, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('NOT_FOUND');
    }
  }, 120_000);

  it("a member of B using A's ids gets NOT_FOUND, and A is untouched", async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const fx = FIXTURES[p.path]!;
      if (!fx.crossInput) continue;
      const bobOnGlobex = seed.caller(seed.users.bob, 'globex');
      const result = await callPath(bobOnGlobex, p.path, fx.crossInput(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe(fx.crossExpect ?? 'NOT_FOUND');
    }
    const carol = await seed.db.runtime.withSystem((s) =>
      s.membership.findUniqueOrThrow({ where: { id: ids.carolMembershipId } }),
    );
    expect(carol.deletedAt).toBeNull();
    expect(carol.role).toBe('VIEWER');
    const rec = await seed.db.runtime.withSystem((s) =>
      s.record.findUniqueOrThrow({ where: { id: ids.recordId } }),
    );
    expect(JSON.stringify(rec.values)).not.toContain('Pwned');
    expect(rec.deletedAt).toBeNull();
    for (const id of [ids.personId, ids.companyId, ids.dealId]) {
      const r = await seed.db.runtime.withSystem((s) =>
        s.record.findUniqueOrThrow({ where: { id } }),
      );
      expect(JSON.stringify(r.values)).not.toContain('Pwned');
    }
    const attr = await seed.db.runtime.withSystem((s) =>
      s.attribute.findUniqueOrThrow({ where: { id: ids.attributeId } }),
    );
    expect(attr.title).toBe('Field');
    expect(attr.deletedAt).toBeNull();
  }, 120_000);

  it('an anonymous caller gets UNAUTHORIZED on user and tenant procedures', async () => {
    const ids = await freshIds();
    for (const p of procedureManifest()) {
      const fx = FIXTURES[p.path]!;
      if (fx.tier === 'public') continue;
      const anon = seed.caller(null, 'acme');
      const result = await callPath(anon, p.path, fx.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('UNAUTHORIZED');
    }
  }, 120_000);

  it("tenant reads never return another workspace's rows", async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const members = await alice.member.list();
    expect(members.every((m) => ['alice@acme.test', 'carol@acme.test'].includes(m.email))).toBe(
      true,
    );
    const audit = await alice.audit.list({ limit: 100 });
    const ids = new Set(audit.items.map((i) => i.id));
    const globexRows = await seed.db.runtime.withSystem((s) =>
      s.auditLog.findMany({ where: { workspaceId: seed.globex.id } }),
    );
    expect(globexRows.length).toBeGreaterThan(0);
    for (const r of globexRows) expect(ids.has(r.id)).toBe(false);
    const types = await alice.objectType.list();
    expect(types.map((t) => t.apiSlug)).toEqual(
      expect.arrayContaining(['person', 'company', 'deal', 'widget']),
    );
    const bob = seed.caller(seed.users.bob, 'globex');
    expect((await bob.objectType.list()).some((t) => t.apiSlug === 'widget')).toBe(false);
  });
});

describe('a viewer cannot mutate anything', () => {
  it('every tenant mutation returns FORBIDDEN for a VIEWER', async () => {
    const ids = await freshIds();
    const mutations = procedureManifest().filter(
      (p) => p.type === 'mutation' && FIXTURES[p.path]?.tier === 'tenant',
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const p of mutations) {
      const carol = seed.caller(seed.users.carol, 'acme');
      const result = await callPath(carol, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('FORBIDDEN');
    }
  }, 120_000);

  it('a viewer can still read', async () => {
    const carol = seed.caller(seed.users.carol, 'acme');
    expect((await carol.workspace.current()).role).toBe('VIEWER');
    expect((await carol.member.list()).length).toBeGreaterThan(0);
    expect(
      (await carol.record.query({ objectType: 'widget' })).attributes.every(
        (a) => a.access === 'READ',
      ),
    ).toBe(true);
  });
});

describe('every mutation writes an audit row', () => {
  it('for each mutation, the AuditLog grows inside the same call', async () => {
    const mutations = procedureManifest().filter((p) => p.type === 'mutation');
    for (const p of mutations) {
      const fx = FIXTURES[p.path]!;
      const ids = await freshIds();
      const before = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      const owner = seed.caller(seed.users.alice, fx.tier === 'tenant' ? 'acme' : null);
      if (p.path === 'invitation.accept') {
        const raw = await inviteBob();
        await seed.caller(seed.users.bob, null).invitation.accept({ token: raw });
      } else if (p.path === 'attribute.restore') {
        await owner.attribute.delete({ id: ids.attributeId });
        const mid = await seed.db.runtime.withSystem((s) => s.auditLog.count());
        await owner.attribute.restore({ id: ids.attributeId });
        expect(await seed.db.runtime.withSystem((s) => s.auditLog.count())).toBeGreaterThan(mid);
        continue;
      } else if (p.path === 'import.rollback') {
        await owner.import.run({ id: ids.importJobId });
        const mid = await seed.db.runtime.withSystem((s) => s.auditLog.count());
        await owner.import.rollback({ id: ids.importJobId });
        expect(await seed.db.runtime.withSystem((s) => s.auditLog.count())).toBeGreaterThan(mid);
        continue;
      } else {
        await callPath(owner, p.path, fx.input(ids));
      }
      const after = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      expect(after, `${p.path} wrote no audit row`).toBeGreaterThan(before);
    }
  }, 300_000);
});

async function inviteBob(): Promise<string> {
  const alice = seed.caller(seed.users.alice, 'acme');
  await seed.db.runtime.withSystem((s) =>
    s.membership.deleteMany({ where: { workspaceId: seed.acme.id, userId: seed.users.bob.id } }),
  );
  await alice.invitation.create({ email: seed.users.bob.email, role: 'MEMBER' });
  const sent = seed.mail.last('invitation');
  const link = sent?.text.match(/https?:\/\/\S+\/invite\/(\S+)/);
  if (!link?.[1]) throw new Error('invitation mail did not contain a link');
  return link[1];
}
