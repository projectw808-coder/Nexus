/**
 * Lists and entries (§6.2): a record can sit in many pipelines with different stage data in
 * each. Entries carry per-list values validated against ListAttribute definitions, a
 * denormalised `stage`, a fractional `position` for drag-reorder, and a stage history.
 */
import {
  NexusError,
  needsRebalance,
  positionBetween,
  rebalancedPositions,
  validateRecordValues,
  type AttributeDef,
  type Option,
} from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Actor, TenantDb } from '../scoped.ts';

export type StageDef = Option;

export async function listAttributeDefs(db: TenantDb, listId: string): Promise<AttributeDef[]> {
  const rows = await db.listAttribute.findMany({
    where: { listId, deletedAt: null },
    orderBy: { position: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    apiSlug: r.apiSlug,
    title: r.title,
    type: r.type,
    config: (r.config ?? {}) as Record<string, unknown>,
    isRequired: false,
    isUnique: false,
    isSystem: false,
  }));
}

export function stagesOf(defs: AttributeDef[]): StageDef[] {
  const stage = defs.find((d) => d.apiSlug === 'stage' && d.type === 'STATUS');
  return Array.isArray(stage?.config['options']) ? (stage.config['options'] as StageDef[]) : [];
}

export async function createList(
  db: TenantDb,
  actor: Actor,
  input: {
    objectTypeId: string;
    name: string;
    kind: 'PIPELINE' | 'COLLECTION';
    stages?: StageDef[];
    description?: string;
  },
): Promise<{ id: string }> {
  if (input.kind === 'PIPELINE' && (!input.stages || input.stages.length === 0)) {
    throw new NexusError('VALIDATION', {
      context: { reason: 'A pipeline needs at least one stage.' },
    });
  }
  const list = await db.list.create({
    data: {
      workspaceId: actor.workspaceId,
      objectTypeId: input.objectTypeId,
      name: input.name,
      kind: input.kind,
      description: input.description ?? null,
      settings: input.kind === 'PIPELINE' ? { stages: input.stages!.map((s) => s.id) } : {},
    },
  });
  if (input.kind === 'PIPELINE') {
    await db.listAttribute.create({
      data: {
        workspaceId: actor.workspaceId,
        listId: list.id,
        apiSlug: 'stage',
        title: 'Stage',
        type: 'STATUS',
        config: { options: input.stages as unknown as Prisma.InputJsonValue },
        position: 0,
      },
    });
  }
  return { id: list.id };
}

async function nextPosition(db: TenantDb, listId: string, stage: string | null): Promise<number> {
  const last = await db.listEntry.findFirst({
    where: { listId, stage, deletedAt: null },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return positionBetween(last?.position ?? null, null);
}

export async function addEntry(
  db: TenantDb,
  actor: Actor,
  input: { listId: string; recordId: string; stage?: string; values?: Record<string, unknown> },
): Promise<{ id: string; stage: string | null; position: number }> {
  const list = await db.list.findFirst({ where: { id: input.listId, deletedAt: null } });
  if (!list) throw new NexusError('NOT_FOUND');
  const record = await db.record.findFirst({
    where: { id: input.recordId, deletedAt: null, objectTypeId: list.objectTypeId },
  });
  if (!record)
    throw new NexusError('NOT_FOUND', {
      context: { reason: 'The record does not exist or belongs to another object.' },
    });
  const defs = await listAttributeDefs(db, list.id);
  const stages = stagesOf(defs);
  const stage = list.kind === 'PIPELINE' ? (input.stage ?? stages[0]?.id ?? null) : null;
  if (list.kind === 'PIPELINE' && !stages.some((s) => s.id === stage)) {
    throw new NexusError('VALIDATION', {
      context: { reason: `Unknown stage "${String(stage)}".` },
    });
  }
  const validated = validateRecordValues(
    defs,
    { ...(input.values ?? {}), ...(stage ? { stage } : {}) },
    'update',
  );
  if (!validated.ok) throw validated.error;
  const stageAttr = defs.find((d) => d.apiSlug === 'stage');
  const values: Record<string, unknown> = { ...validated.value.values };
  if (stageAttr && stage) {
    values[stageAttr.id] = stage;
    values['enteredStageAt'] = new Date().toISOString();
  }

  const existing = await db.listEntry.findUnique({
    where: {
      workspaceId_listId_recordId: {
        workspaceId: actor.workspaceId,
        listId: list.id,
        recordId: record.id,
      },
    },
  });
  if (existing && !existing.deletedAt) {
    throw new NexusError('CONFLICT', {
      context: { reason: 'The record is already in this list.' },
      details: { entryId: existing.id },
    });
  }
  const position = await nextPosition(db, list.id, stage);
  const entry = existing
    ? await db.listEntry.update({
        where: { id: existing.id },
        data: { deletedAt: null, values: values as Prisma.InputJsonValue, stage, position },
      })
    : await db.listEntry.create({
        data: {
          workspaceId: actor.workspaceId,
          listId: list.id,
          recordId: record.id,
          values: values as Prisma.InputJsonValue,
          stage,
          position,
        },
      });
  if (stage) {
    await db.listStageHistory.create({
      data: {
        workspaceId: actor.workspaceId,
        listEntryId: entry.id,
        fromStage: null,
        toStage: stage,
        changedById: actor.userId,
      },
    });
  }
  return { id: entry.id, stage: entry.stage, position: entry.position };
}

/**
 * Move an entry to a stage and/or a position between two neighbours (ids of entries in the
 * destination stage). Rebalances the destination group when float precision runs out.
 */
export async function moveEntry(
  db: TenantDb,
  actor: Actor,
  input: {
    entryId: string;
    stage?: string;
    afterEntryId?: string | null;
    beforeEntryId?: string | null;
  },
): Promise<{ id: string; stage: string | null; position: number; rebalanced: boolean }> {
  const entry = await db.listEntry.findFirst({
    where: { id: input.entryId, deletedAt: null },
    include: { list: true },
  });
  if (!entry) throw new NexusError('NOT_FOUND');
  const defs = await listAttributeDefs(db, entry.listId);
  const stages = stagesOf(defs);
  const stage = entry.list.kind === 'PIPELINE' ? (input.stage ?? entry.stage) : null;
  if (entry.list.kind === 'PIPELINE' && !stages.some((s) => s.id === stage)) {
    throw new NexusError('VALIDATION', {
      context: { reason: `Unknown stage "${String(stage)}".` },
    });
  }

  const neighbour = async (id: string | null | undefined) =>
    id
      ? ((
          await db.listEntry.findFirst({
            where: { id, listId: entry.listId, stage, deletedAt: null },
            select: { position: true },
          })
        )?.position ?? null)
      : null;
  let after = await neighbour(input.afterEntryId);
  let before = await neighbour(input.beforeEntryId);
  if (input.afterEntryId === undefined && input.beforeEntryId === undefined) {
    // No placement given: append to the destination stage.
    after =
      (
        await db.listEntry.findFirst({
          where: { listId: entry.listId, stage, deletedAt: null, id: { not: entry.id } },
          orderBy: { position: 'desc' },
        })
      )?.position ?? null;
    before = null;
  }

  let rebalanced = false;
  if (needsRebalance(after, before)) {
    const group = await db.listEntry.findMany({
      where: { listId: entry.listId, stage, deletedAt: null, id: { not: entry.id } },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    const positions = rebalancedPositions(group.length);
    for (let i = 0; i < group.length; i++) {
      await db.listEntry.update({ where: { id: group[i]!.id }, data: { position: positions[i]! } });
    }
    after = await neighbour(input.afterEntryId);
    before = await neighbour(input.beforeEntryId);
    rebalanced = true;
  }
  const position = positionBetween(after, before);

  const values = { ...((entry.values ?? {}) as Record<string, unknown>) };
  const stageAttr = defs.find((d) => d.apiSlug === 'stage');
  const stageChanged = stage !== entry.stage;
  if (stageChanged && stageAttr && stage) {
    values[stageAttr.id] = stage;
    values['enteredStageAt'] = new Date().toISOString();
  }
  const updated = await db.listEntry.update({
    where: { id: entry.id },
    data: { stage, position, values: values as Prisma.InputJsonValue },
  });
  if (stageChanged && stage) {
    await db.listStageHistory.create({
      data: {
        workspaceId: actor.workspaceId,
        listEntryId: entry.id,
        fromStage: entry.stage,
        toStage: stage,
        changedById: actor.userId,
      },
    });
  }
  return { id: updated.id, stage: updated.stage, position: updated.position, rebalanced };
}

export async function updateEntryValues(
  db: TenantDb,
  input: { entryId: string; values: Record<string, unknown> },
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
  const entry = await db.listEntry.findFirst({ where: { id: input.entryId, deletedAt: null } });
  if (!entry) throw new NexusError('NOT_FOUND');
  const defs = await listAttributeDefs(db, entry.listId);
  if ('stage' in input.values || defs.some((d) => d.apiSlug === 'stage' && d.id in input.values)) {
    throw new NexusError('VALIDATION', {
      context: { reason: 'Change the stage with moveEntry so the history is kept.' },
    });
  }
  const validated = validateRecordValues(defs, input.values, 'update');
  if (!validated.ok) throw validated.error;
  const before = (entry.values ?? {}) as Record<string, unknown>;
  const after: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(validated.value.values)) {
    if (v === null) delete after[k];
    else after[k] = v;
  }
  await db.listEntry.update({
    where: { id: entry.id },
    data: { values: after as Prisma.InputJsonValue },
  });
  return { before, after };
}

export async function removeEntry(db: TenantDb, entryId: string): Promise<void> {
  const entry = await db.listEntry.findFirst({ where: { id: entryId, deletedAt: null } });
  if (!entry) throw new NexusError('NOT_FOUND');
  await db.listEntry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } });
}
