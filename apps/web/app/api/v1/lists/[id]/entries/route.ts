/**
 * `GET /v1/lists/{id}/entries` · `POST /v1/lists/{id}/entries` (§11.2).
 *
 * Adding an entry is `addEntry` from @nexus/db — the function the `listEntry.add` procedure
 * calls — so stage validation, the fractional index and the WIP rules are the existing ones.
 * The page is keyed on `(position, id)`, the order a board renders in.
 */
import { createListEntrySchema, pageQuerySchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { addEntry } from '@nexus/db';
import { z } from 'zod';
import { attributesFor, recordLabel } from '@/server/objects-helpers';
import { restRoute } from '../../../_lib/handler';
import { cappedLimit, decodeNumberCursor, encodeCursor } from '../../../_lib/shapes';

export const dynamic = 'force-dynamic';

const listQuery = pageQuerySchema.extend({ stage: z.string().max(64).optional() });

export const GET = restRoute<{ id: string }>('READ', async (ctx, params) => {
  const q = ctx.query(listQuery);
  const take = cappedLimit(q.limit);
  const after = decodeNumberCursor(q.cursor);
  return ctx.withTenant(async (db) => {
    const list = await db.list.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, objectTypeId: true },
    });
    if (!list) throw new NexusError('NOT_FOUND', { message: 'List not found.' });
    const attrs = await attributesFor(db, list.objectTypeId);
    const rows = await db.listEntry.findMany({
      where: {
        listId: list.id,
        deletedAt: null,
        record: { deletedAt: null },
        ...(q.stage ? { stage: q.stage } : {}),
        ...(after
          ? {
              OR: [
                { position: { gt: after.value } },
                { position: after.value, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: take + 1,
      include: { record: { select: { values: true } } },
    });
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      body: {
        items: page.map((e) => ({
          id: e.id,
          listId: e.listId,
          recordId: e.recordId,
          label: recordLabel(attrs, e.record.values as Record<string, unknown>),
          stage: e.stage,
          position: e.position,
          values: e.values as Record<string, unknown>,
          createdAt: e.createdAt,
        })),
        nextCursor: rows.length > take && last ? encodeCursor(last.position, last.id) : null,
      },
    };
  });
});

export const POST = restRoute<{ id: string }>('WRITE', async (ctx, params) => {
  const input = ctx.parse(createListEntrySchema);
  return ctx.withTenant(async (db, actor) => {
    const list = await db.list.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, objectTypeId: true },
    });
    if (!list) throw new NexusError('NOT_FOUND', { message: 'List not found.' });
    const entry = await addEntry(db, actor, {
      listId: list.id,
      recordId: input.recordId,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.values ? { values: input.values } : {}),
    });
    const attrs = await attributesFor(db, list.objectTypeId);
    const record = await db.record.findFirst({
      where: { id: input.recordId },
      select: { values: true },
    });
    const row = await db.listEntry.findFirstOrThrow({
      where: { id: entry.id },
      select: { id: true, listId: true, recordId: true, values: true, createdAt: true },
    });
    await ctx.audit(db, {
      action: 'list_entry.added',
      targetType: 'ListEntry',
      targetId: entry.id,
      diff: { listId: list.id, recordId: input.recordId, stage: entry.stage, via: 'rest_v1' },
    });
    await ctx.deps.jobs.dispatch('automate.react', {
      workspaceId: actor.workspaceId,
      type: 'list.entry_added',
      occurredAt: new Date().toISOString(),
      recordId: input.recordId,
      listId: list.id,
      entryId: entry.id,
      payload: { stage: entry.stage },
      causation: { workflowIds: [] },
    });
    return {
      status: 201,
      body: {
        id: row.id,
        listId: row.listId,
        recordId: row.recordId,
        label: recordLabel(attrs, (record?.values ?? {}) as Record<string, unknown>),
        stage: entry.stage,
        position: entry.position,
        values: row.values as Record<string, unknown>,
        createdAt: row.createdAt,
      },
    };
  });
});
