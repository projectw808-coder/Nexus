import { NexusError, recordQuerySchema } from '@nexus/core';
import {
  alternatesFor,
  countRecords,
  createRecord,
  diffOf,
  emitTimelineEvent,
  mergeRecords,
  unmergeRecords,
  queryRecords,
  restoreRecords,
  softDeleteRecords,
  updateRecord,
} from '@nexus/db';
import { dispatchOutboundWebhooks } from '@nexus/sync';
import { z } from 'zod';
import { identitySummary, linkSummary, personLabels } from '../identity-helpers';
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
        // Phase 6: channel identities (chips), field alternates kept by merges, merge history.
        const identities = await ctx.db.identity.findMany({
          where: { personRecordId: row.id, deletedAt: null },
          orderBy: { lastSeenAt: 'desc' },
          include: {
            links: {
              where: { revokedAt: null },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { confirmedBy: { select: { name: true, email: true } } },
            },
          },
        });
        const merges = await ctx.db.recordMerge.findMany({
          where: { OR: [{ winnerId: row.id }, { loserId: row.id }] },
          orderBy: { mergedAt: 'desc' },
          include: {
            mergedBy: { select: { name: true, email: true } },
            unmergedBy: { select: { name: true, email: true } },
          },
        });
        const mergeLabels = await personLabels(ctx.db, [
          ...merges.flatMap((m) => [m.winnerId, m.loserId]),
          ...(row.mergedIntoId ? [row.mergedIntoId] : []),
        ]);
        const alternates = await alternatesFor(ctx.db, row.id);
        return {
          ...record,
          mergeState: row.mergeState,
          mergedInto: row.mergedIntoId
            ? {
                id: row.mergedIntoId,
                label: mergeLabels.get(row.mergedIntoId)?.label ?? '(record)',
              }
            : null,
          identities: identities.map((i) => ({
            ...identitySummary(i),
            link: i.links[0] ? linkSummary(i.links[0]) : null,
          })),
          alternates,
          merges: merges.map((m) => {
            const snap = m.snapshot as {
              fields?: unknown[];
              identities?: unknown[];
              timelineEvents?: unknown[];
            };
            return {
              id: m.id,
              winner: { id: m.winnerId, label: mergeLabels.get(m.winnerId)?.label ?? '(record)' },
              loser: { id: m.loserId, label: mergeLabels.get(m.loserId)?.label ?? '(record)' },
              mergedAt: m.mergedAt,
              mergedBy: m.mergedBy,
              unmergedAt: m.unmergedAt,
              unmergedBy: m.unmergedBy,
              moved: {
                fields: snap.fields?.length ?? 0,
                identities: snap.identities?.length ?? 0,
                timelineEvents: snap.timelineEvents?.length ?? 0,
              },
            };
          }),
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
        await ctx.jobs.dispatch('automate.react', {
          workspaceId: ctx.workspace.id,
          type: 'record.created',
          occurredAt: new Date().toISOString(),
          recordId: row.id,
          objectTypeApiSlug: ot.apiSlug,
          payload: { values: row.values },
          causation: { workflowIds: [] },
        });
        // Phase 11 (ADR-022 decision 4): the same event, fanned out to customer webhooks.
        await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
          workspaceId: ctx.workspace.id,
          type: 'record.created',
          recordId: row.id,
          objectTypeApiSlug: ot.apiSlug,
          payload: { values: row.values },
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
          select: { objectTypeId: true, objectType: { select: { apiSlug: true } } },
        });
        if (!existing) throw new NexusError('NOT_FOUND');
        const attrs = await attributesFor(ctx.db, existing.objectTypeId);
        const { before, after } = await updateRecord(ctx.db, ctx.actor, {
          recordId: input.id,
          attributes: attrs,
          input: input.values,
        });
        const changed = diffOf(before.values, after.values);
        const changedTitles = Object.keys(changed)
          .map((k) => attrs.find((a) => a.id === k)?.title ?? null)
          .filter((t): t is string => t !== null);
        if (changedTitles.length)
          await emitTimelineEvent(ctx.db, {
            workspaceId: ctx.workspace.id,
            dedupeKey: `field:${after.id}:${Date.now()}`,
            type: 'FIELD_CHANGE',
            occurredAt: new Date(),
            recordId: after.id,
            actorUserId: ctx.session.id,
            summary: `Changed ${changedTitles.slice(0, 3).join(', ')}${changedTitles.length > 3 ? ` and ${changedTitles.length - 3} more` : ''}`,
            payload: { kind: 'field_change', changed },
          });
        await ctx.audit({
          action: 'record.updated',
          targetType: 'Record',
          targetId: after.id,
          diff: changed,
        });
        if (changedTitles.length)
          await ctx.jobs.dispatch('automate.react', {
            workspaceId: ctx.workspace.id,
            type: 'record.updated',
            occurredAt: new Date().toISOString(),
            recordId: after.id,
            objectTypeApiSlug: existing.objectType.apiSlug,
            payload: { changed, values: after.values },
            causation: { workflowIds: [] },
          });
        // Phase 11 (ADR-022 decision 4): the same event, fanned out to customer webhooks.
        if (changedTitles.length)
          await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
            workspaceId: ctx.workspace.id,
            type: 'record.updated',
            recordId: after.id,
            objectTypeApiSlug: existing.objectType.apiSlug,
            payload: { changed, values: after.values },
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

    /** Reversible merge (§10, ADR-002): the loser is kept, every moved row is in the snapshot. */
    merge: tenantProcedure
      .use(authorize('delete', 'RecordMerge'))
      .input(
        z.object({
          winnerId: z.string().uuid(),
          loserId: z.string().uuid(),
          reason: z.string().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (fixed) {
          const both = await ctx.db.record.count({
            where: { id: { in: [input.winnerId, input.loserId] }, objectType: { apiSlug: fixed } },
          });
          if (both !== 2) throw new NexusError('NOT_FOUND');
        }
        const r = await mergeRecords(ctx.db, ctx.actor, {
          winnerId: input.winnerId,
          loserId: input.loserId,
          reason: input.reason ?? null,
        });
        await ctx.audit({
          action: 'record.merged',
          targetType: 'Record',
          targetId: r.winnerId,
          diff: {
            mergeId: r.mergeId,
            loserId: r.loserId,
            fields: r.snapshot.fields,
            moved: {
              identities: r.snapshot.identities.length,
              conversations: r.snapshot.conversations.length,
              timelineEvents: r.snapshot.timelineEvents.length,
              listEntries: r.snapshot.listEntries.length,
              relations: r.snapshot.relations.length,
            },
          },
        });
        return { mergeId: r.mergeId, winnerId: r.winnerId, loserId: r.loserId };
      }),

    unmerge: tenantProcedure
      .use(authorize('delete', 'RecordMerge'))
      .input(
        z.object({
          mergeId: z.string().uuid(),
          neverMerge: z.boolean().default(true),
          reason: z.string().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const r = await unmergeRecords(ctx.db, ctx.actor, {
          mergeId: input.mergeId,
          neverMerge: input.neverMerge,
          reason: input.reason ?? null,
        });
        await ctx.audit({
          action: 'record.unmerged',
          targetType: 'Record',
          targetId: r.winnerId,
          diff: { mergeId: r.mergeId, loserId: r.loserId, neverMergeId: r.neverMergeId },
        });
        return r;
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
