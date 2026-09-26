/**
 * `GET`/`PATCH`/`DELETE /v1/objects/{slug}/records/{id}` (§11.2).
 *
 * `PATCH` merges: a `null` clears that attribute, an omitted attribute is left alone — the same
 * semantics `updateRecord` gives the UI. `DELETE` is the soft delete `softDeleteRecords`
 * performs, so a deleted record is still recoverable and still visible with `includeDeleted`.
 */
import { recordValuesSchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { diffOf, emitTimelineEvent, softDeleteRecords, updateRecord } from '@nexus/db';
import { attributesFor, resolveObjectType } from '@/server/objects-helpers';
import { restRoute } from '../../../../_lib/handler';
import { restRecord } from '../../../../_lib/shapes';

export const dynamic = 'force-dynamic';

type Params = { slug: string; id: string };

export const GET = restRoute<Params>('READ', async (ctx, params) =>
  ctx.withTenant(async (db, actor) => {
    const ot = await resolveObjectType(db, params.slug);
    const row = await db.record.findFirst({ where: { id: params.id, objectTypeId: ot.id } });
    if (!row) throw new NexusError('NOT_FOUND', { message: 'Record not found.' });
    const attrs = await attributesFor(db, ot.id);
    return {
      body: restRecord(actor, attrs, { ...row, values: row.values as Record<string, unknown> }),
    };
  }),
);

export const PATCH = restRoute<Params>('WRITE', async (ctx, params) => {
  const input = ctx.parse(recordValuesSchema);
  return ctx.withTenant(async (db, actor) => {
    const ot = await resolveObjectType(db, params.slug);
    const existing = await db.record.findFirst({
      where: { id: params.id, objectTypeId: ot.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NexusError('NOT_FOUND', { message: 'Record not found.' });
    const attrs = await attributesFor(db, ot.id);
    const { before, after } = await updateRecord(db, actor, {
      recordId: existing.id,
      attributes: attrs,
      input: input.values,
    });
    const changed = diffOf(before.values, after.values);
    const changedTitles = Object.keys(changed)
      .map((k) => attrs.find((a) => a.id === k)?.title ?? null)
      .filter((t): t is string => t !== null);
    if (changedTitles.length) {
      await emitTimelineEvent(db, {
        workspaceId: actor.workspaceId,
        dedupeKey: `field:${after.id}:${Date.now()}`,
        type: 'FIELD_CHANGE',
        occurredAt: new Date(),
        recordId: after.id,
        summary: `Changed ${changedTitles.slice(0, 3).join(', ')}${
          changedTitles.length > 3 ? ` and ${changedTitles.length - 3} more` : ''
        }`,
        payload: { kind: 'field_change', changed },
      });
    }
    await ctx.audit(db, {
      action: 'record.updated',
      targetType: 'Record',
      targetId: after.id,
      diff: { ...changed, via: 'rest_v1' },
    });
    if (changedTitles.length) {
      await ctx.deps.jobs.dispatch('automate.react', {
        workspaceId: actor.workspaceId,
        type: 'record.updated',
        occurredAt: new Date().toISOString(),
        recordId: after.id,
        objectTypeApiSlug: ot.apiSlug,
        payload: { changed, values: after.values },
        causation: { workflowIds: [] },
      });
    }
    return { body: restRecord(actor, attrs, after) };
  });
});

export const DELETE = restRoute<Params>('WRITE', async (ctx, params) =>
  ctx.withTenant(async (db) => {
    const ot = await resolveObjectType(db, params.slug);
    const existing = await db.record.findFirst({
      where: { id: params.id, objectTypeId: ot.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NexusError('NOT_FOUND', { message: 'Record not found.' });
    await softDeleteRecords(db, [existing.id]);
    await ctx.audit(db, {
      action: 'record.deleted',
      targetType: 'Record',
      targetId: existing.id,
      diff: { via: 'rest_v1' },
    });
    return { body: { id: existing.id, deleted: true } };
  }),
);
