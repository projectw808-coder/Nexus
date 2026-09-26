/**
 * Versioning with rollback (§14) and the remaining dry-run shapes (record- and list-triggered),
 * against a real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addEntry,
  createList,
  createRecord,
  loadAttributes,
  personAttributes,
  systemActorFor,
  type Actor,
} from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { dryRun } from './dry-run.ts';
import { listWorkflowVersions, rollbackWorkflow, snapshotWorkflowVersion } from './versions.ts';

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let ownerId: string;
let listId: string;
let personTypeId: string;

const V1_TRIGGER = { type: 'comment.received', platform: 'INSTAGRAM' };
const V1_CONDITIONS = { leaf: { path: 'event.payload.body', op: 'contains', value: 'price' } };
const V1_ACTIONS = [{ id: 'a1', type: 'create_note', text: 'v1' }];

const V2_TRIGGER = { type: 'message.received' };
const V2_ACTIONS = [{ id: 'a1', type: 'create_note', text: 'v2' }];

async function seedWorkflow(name: string) {
  return db.runtime.withTenant(actor, async (t) => {
    const workflow = await t.workflow.create({
      data: {
        workspaceId,
        name,
        enabled: true,
        trigger: V1_TRIGGER,
        conditions: V1_CONDITIONS,
        actions: V1_ACTIONS,
        createdById: ownerId,
      },
      select: { id: true, workspaceId: true, version: true },
    });
    await snapshotWorkflowVersion(t, actor, {
      ...workflow,
      trigger: V1_TRIGGER,
      conditions: V1_CONDITIONS,
      actions: V1_ACTIONS,
    });
    return workflow;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  const owner = await db.prisma.user.create({
    data: { email: 'owner@versions.test', name: 'Owner' },
  });
  ownerId = owner.id;
  const ws = await db.tenancy.createWorkspace({
    name: 'Versions',
    slug: 'versions',
    ownerUserId: ownerId,
  });
  workspaceId = ws.id;
  actor = { ...systemActorFor(ws.id), userId: ownerId, actorType: 'USER' };

  await db.runtime.withTenant(actor, async (t) => {
    const pa = await personAttributes(t);
    personTypeId = pa.objectTypeId;
    const list = await createList(t, actor, {
      objectTypeId: personTypeId,
      name: 'Deals',
      kind: 'PIPELINE',
      stages: [
        { id: 'new', label: 'New' },
        { id: 'won', label: 'Won' },
      ],
    });
    listId = list.id;
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('snapshotWorkflowVersion', () => {
  it('records what the workflow looks like at its current version', async () => {
    const workflow = await seedWorkflow('snapshot me');
    const versions = await db.runtime.withTenant(actor, (t) =>
      listWorkflowVersions(t, workflow.id),
    );
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]?.createdById).toBe(ownerId);
  }, 60_000);

  it('re-snapshotting the same version overwrites rather than failing the unique index', async () => {
    const workflow = await seedWorkflow('idempotent snapshot');
    await db.runtime.withTenant(actor, (t) =>
      snapshotWorkflowVersion(t, actor, {
        ...workflow,
        trigger: V2_TRIGGER,
        conditions: {},
        actions: V2_ACTIONS,
      }),
    );
    const versions = await db.runtime.withTenant(actor, (t) =>
      listWorkflowVersions(t, workflow.id),
    );
    expect(versions).toHaveLength(1);
    const stored = await db.runtime.withTenant(actor, (t) =>
      t.workflowVersion.findFirstOrThrow({ where: { workflowId: workflow.id, version: 1 } }),
    );
    expect(stored.trigger).toEqual(V2_TRIGGER);
  }, 60_000);
});

describe('rollbackWorkflow', () => {
  it('copies an old version onto the live row, bumps the version and snapshots the rollback', async () => {
    const workflow = await seedWorkflow('rollback me');

    // A real edit: change the definition, bump the version, snapshot v2.
    await db.runtime.withTenant(actor, async (t) => {
      const updated = await t.workflow.update({
        where: { id: workflow.id },
        data: { trigger: V2_TRIGGER, conditions: {}, actions: V2_ACTIONS, version: 2 },
        select: { id: true, workspaceId: true, version: true },
      });
      await snapshotWorkflowVersion(t, actor, {
        ...updated,
        trigger: V2_TRIGGER,
        conditions: {},
        actions: V2_ACTIONS,
      });
    });

    const rolled = await db.runtime.withTenant(actor, (t) =>
      rollbackWorkflow(t, actor, workflow.id, 1),
    );

    expect(rolled.version).toBe(3);
    expect(rolled.trigger).toEqual(V1_TRIGGER);
    expect(rolled.conditions).toEqual(V1_CONDITIONS);
    expect(rolled.actions).toEqual(V1_ACTIONS);

    // Nothing was deleted; the rollback is itself a version.
    const versions = await db.runtime.withTenant(actor, (t) =>
      listWorkflowVersions(t, workflow.id),
    );
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);

    const v3 = await db.runtime.withTenant(actor, (t) =>
      t.workflowVersion.findFirstOrThrow({ where: { workflowId: workflow.id, version: 3 } }),
    );
    expect(v3.trigger).toEqual(V1_TRIGGER);

    const audit = await db.runtime.withTenant(actor, (t) =>
      t.auditLog.findFirst({ where: { action: 'workflow.rolled_back', targetId: workflow.id } }),
    );
    expect(audit?.diff).toMatchObject({ restoredVersion: 1, newVersion: 3 });
  }, 60_000);

  it('refuses a version that does not exist', async () => {
    const workflow = await seedWorkflow('no such version');
    await expect(
      db.runtime.withTenant(actor, (t) => rollbackWorkflow(t, actor, workflow.id, 99)),
    ).rejects.toThrow();
  }, 60_000);
});

describe('dryRun over non-timeline triggers', () => {
  const person = (values: Record<string, unknown>) =>
    db.runtime.withTenant(actor, async (t) => {
      const pa = await personAttributes(t);
      const attributes = await loadAttributes(t, pa.objectTypeId);
      const bySlug = Object.fromEntries(attributes.map((a) => [a.apiSlug, a.id]));
      return createRecord(t, actor, {
        objectTypeId: pa.objectTypeId,
        attributes,
        input: Object.fromEntries(Object.entries(values).map(([k, v]) => [bySlug[k]!, v])),
      });
    });

  it('replays record.created narrowed by object type, and evaluates record.* conditions', async () => {
    await person({ name: 'Dry One', email: 'one@dry.test' });
    await person({ name: 'Dry Two', email: 'two@other.test' });

    const all = await db.runtime.withTenant(actor, (t) =>
      dryRun(t, workspaceId, {
        trigger: { type: 'record.created', objectTypeApiSlug: 'person' },
        conditions: {},
        actions: [{ id: 'a1', type: 'create_note', text: 'hi' }],
      }),
    );
    expect(all.evaluated).toBeGreaterThanOrEqual(2);
    expect(all.matched).toBe(all.evaluated);

    const narrowed = await db.runtime.withTenant(actor, (t) =>
      dryRun(t, workspaceId, {
        trigger: { type: 'record.created', objectTypeApiSlug: 'person' },
        conditions: { leaf: { path: 'record.email', op: 'contains', value: '@dry.test' } },
        actions: [{ id: 'a1', type: 'create_note', text: 'hi' }],
      }),
    );
    expect(narrowed.matched).toBe(1);
    expect(narrowed.samples[0]?.wouldRunActions).toEqual(['a1:create_note']);
  }, 60_000);

  it('matches nothing when the trigger names an object type that does not exist', async () => {
    const report = await db.runtime.withTenant(actor, (t) =>
      dryRun(t, workspaceId, {
        trigger: { type: 'record.created', objectTypeApiSlug: 'unicorn' },
        conditions: {},
        actions: [],
      }),
    );
    expect(report).toMatchObject({ evaluated: 0, matched: 0 });
  }, 60_000);

  it('replays list.entry_added for one list', async () => {
    const someone = await person({ name: 'Lister', email: 'lister@dry.test' });
    await db.runtime.withTenant(actor, (t) =>
      addEntry(t, actor, { listId, recordId: someone.id, stage: 'new' }),
    );

    const report = await db.runtime.withTenant(actor, (t) =>
      dryRun(t, workspaceId, {
        trigger: { type: 'list.entry_added', listId },
        conditions: { leaf: { path: 'event.payload.stage', op: 'eq', value: 'new' } },
        actions: [{ id: 'a1', type: 'create_note', text: 'entered' }],
      }),
    );
    expect(report).toMatchObject({ windowDays: 7, evaluated: 1, matched: 1 });
  }, 60_000);

  it('honours a custom window and reports zero for triggers with no replayable trail', async () => {
    const scheduled = await db.runtime.withTenant(actor, (t) =>
      dryRun(
        t,
        workspaceId,
        { trigger: { type: 'schedule', cron: '0 9 * * 1' }, conditions: {}, actions: [] },
        { days: 30 },
      ),
    );
    expect(scheduled).toMatchObject({ windowDays: 30, evaluated: 0, matched: 0, samples: [] });
  }, 60_000);
});
