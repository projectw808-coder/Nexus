import { NexusError, recordQuerySchema } from '@nexus/core';
import {
  countRecords,
  createRecord,
  diffOf,
  queryRecords,
  restoreRecords,
  softDeleteRecords,
  updateRecord,
} from '@nexus/db';
import { z } from 'zod';
import {
  attributesFor,
  publicAttributes,
  publicRecord,
  recordLabel,
  resolveObjectType,
} from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

const values = z.record(z.string(), z.unknown());

/**
 * The generic record router, and the typed conveniences `person`, `company`, `deal` (§11.1,
 * ADR-001): same procedures, object fixed — no parallel storage.
 */
export function recordRouterFor(fixed?: 'person' | 'company' | 'deal') {
  const objectInput = z.object({ objectType: z.string().min(1).optional() });
  const ref = (input: { objectType?: string | undefined }): string => {
    const r = fixed ?? input.objectType;
    if (!r) throw new NexusError('VALIDATION', { context: { reason: 'objectType is required.' } });
    return r;
  };

  return router({
    query: tenantProcedure
      .use(authorize('read', 'Record'))
      .input(
        objectInput.extend({
          query: recordQuerySchema.default({
            filters: [],
            sort: [],
            limit: 50,
            includeDeleted: false,
          }),
        }),
      )
      .query(async ({ ctx, input }) => {
        const ot = await resolveObjectType(ctx.db, ref(input));
        const attrs = await attributesFor(ctx.db, ot.id);
        const result = await queryRecords(ctx.db, {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          attributes: attrs,
          query: input.query,
        });
        const total = await countRecords(ctx.db, {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          attributes: attrs,
          filters: input.query.filters,
          search: input.query.search,
        });
        return {
          objectType: ot,
          attributes: publicAttributes(ctx.actor, attrs),
          items: result.items.map((r) => ({
            ...publicRecord(ctx.actor, attrs, r),
            label: recordLabel(attrs, r.values),
          })),
          nextCursor: result.nextCursor,
          total,
        };
      }),

    get: tenantProcedure
      .use(authorize('read', 'Record'))
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const row = await ctx.db.record.findFirst({
          where: {
            id: input.id,
            mergeState: 'ACTIVE',
            ...(fixed ? { objectType: { apiSlug: fixed } } : {}),
          },
          include: { objectType: true },
        });
        if (!row) throw new NexusError('NOT_FOUND');
        const attrs = await attributesFor(ctx.db, row.objectTypeId);
        const relations = await ctx.db.recordRelation.findMany({
          where: { OR: [{ fromRecordId: row.id }, { toRecordId: row.id }], deletedAt: null },
          include: {
            fromRecord: { select: { id: true, objectTypeId: true, values: true } },
            toRecord: { select: { id: true, objectTypeId: true, values: true } },
            attribute: { select: { id: true, apiSlug: true, title: true } },
          },
        });
        const entries = await ctx.db.listEntry.findMany({
          where: { recordId: row.id, deletedAt: null },
          include: { list: { select: { id: true, name: true, kind: true } } },
        });
        const record = publicRecord(ctx.actor, attrs, {
          ...row,
          values: row.values as Record<string, unknown>,
          importJobId: row.importJobId,
        });
        return {
          ...record,
          label: recordLabel(attrs, row.values as Record<string, unknown>),
          objectType: {
            id: row.objectType.id,
            apiSlug: row.objectType.apiSlug,
            singular: row.objectType.singular,
            plural: row.objectType.plural,
          },
          attributes: publicAttributes(ctx.actor, attrs),
          relations: relations.map((rel) => ({
            attribute: rel.attribute,
            direction: rel.fromRecordId === row.id ? ('out' as const) : ('in' as const),
            other:
              rel.fromRecordId === row.id
                ? { id: rel.toRecord.id, objectTypeId: rel.toRecord.objectTypeId }
                : { id: rel.fromRecord.id, objectTypeId: rel.fromRecord.objectTypeId },
          })),
          lists: entries.map((e) => ({
            entryId: e.id,
            listId: e.list.id,
            name: e.list.name,
            kind: e.list.kind,
            stage: e.stage,
          })),
        };
      }),

    create: tenantProcedure
      .use(authorize('create', 'Record'))
      .input(objectInput.extend({ values }))
      .mutation(async ({ ctx, input }) => {
        const ot = await resolveObjectType(ctx.db, ref(input));
        const attrs = await attributesFor(ctx.db, ot.id);
        const row = await createRecord(ctx.db, ctx.actor, {
          objectTypeId: ot.id,
          attributes: attrs,
          input: input.values,
        });
        await ctx.audit({
          action: 'record.created',
          targetType: 'Record',
          targetId: row.id,
          diff: { objectType: ot.apiSlug, values: row.values },
        });
        return { ...publicRecord(ctx.actor, attrs, row), label: recordLabel(attrs, row.values) };
      }),

    update: tenantProcedure
      .use(authorize('update', 'Record'))
      .input(z.object({ id: z.string().uuid(), values }))
      .mutation(async ({ ctx, input }) => {
        const existing = await ctx.db.record.findFirst({
          where: {
            id: input.id,
            deletedAt: null,
            ...(fixed ? { objectType: { apiSlug: fixed } } : {}),
          },
          select: { objectTypeId: true },
        });
        if (!existing) throw new NexusError('NOT_FOUND');
        const attrs = await attributesFor(ctx.db, existing.objectTypeId);
        const { before, after } = await updateRecord(ctx.db, ctx.actor, {
          recordId: input.id,
          attributes: attrs,
          input: input.values,
        });
        await ctx.audit({
          action: 'record.updated',
          targetType: 'Record',
          targetId: after.id,
          diff: diffOf(before.values, after.values),
        });
        return {
          ...publicRecord(ctx.actor, attrs, after),
          label: recordLabel(attrs, after.values),
        };
      }),

    delete: tenantProcedure
      .use(authorize('delete', 'Record'))
      .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const count = await softDeleteRecords(ctx.db, input.ids);
        await ctx.audit({
          action: 'record.deleted',
          targetType: 'Record',
          targetId: input.ids[0]!,
          diff: { ids: input.ids, count },
        });
        return { count };
      }),

    /** Bulk action: apply the same values to many records; one audit row per record. */
    bulkUpdate: tenantProcedure
      .use(authorize('update', 'Record'))
      .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), values }))
      .mutation(async ({ ctx, input }) => {
        let updated = 0;
        for (const id of input.ids) {
          const existing = await ctx.db.record.findFirst({
            where: { id, deletedAt: null, ...(fixed ? { objectType: { apiSlug: fixed } } : {}) },
            select: { objectTypeId: true },
          });
          if (!existing) continue;
          const attrs = await attributesFor(ctx.db, existing.objectTypeId);
          const { before, after } = await updateRecord(ctx.db, ctx.actor, {
            recordId: id,
            attributes: attrs,
            input: input.values,
          });
          await ctx.audit({
            action: 'record.updated',
            targetType: 'Record',
            targetId: id,
            diff: diffOf(before.values, after.values),
          });
          updated += 1;
        }
        if (updated === 0) {
          await ctx.audit({
            action: 'record.bulk_update_noop',
            targetType: 'Record',
            targetId: input.ids[0]!,
            diff: { ids: input.ids },
          });
        }
        return { updated };
      }),

    /** Field history from the audit trail (§12.2.B history popover). */
    history: tenantProcedure
      .use(authorize('read', 'Record'))
      .input(
        z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.db.auditLog.findMany({
          where: {
            targetType: 'Record',
            targetId: input.id,
            action: {
              in: ['record.created', 'record.updated', 'record.deleted', 'record.restored'],
            },
          },
          include: { actorUser: { select: { name: true, email: true } } },
          orderBy: { at: 'desc' },
          take: input.limit,
        });
        return rows.map((a) => ({
          id: a.id,
          at: a.at,
          action: a.action,
          actor: a.actorUser?.name ?? a.actorUser?.email ?? a.actorType.toLowerCase(),
          diff: a.diff as Record<string, unknown>,
        }));
      }),

    restore: tenantProcedure
      .use(authorize('delete', 'Record'))
      .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const count = await restoreRecords(ctx.db, input.ids);
        await ctx.audit({
          action: 'record.restored',
          targetType: 'Record',
          targetId: input.ids[0]!,
          diff: { ids: input.ids, count },
        });
        return { count };
      }),
  });
}

export const recordRouter = recordRouterFor();
export const personRouter = recordRouterFor('person');
export const companyRouter = recordRouterFor('company');
export const dealRouter = recordRouterFor('deal');
