import { NexusError, optionSchema } from '@nexus/core';
import {
  addEntry,
  createList,
  listAttributeDefs,
  moveEntry,
  removeEntry,
  stagesOf,
  updateEntryValues,
  type Prisma,
  emitTimelineEvent,
} from '@nexus/db';
import { dispatchOutboundWebhooks } from '@nexus/sync';
import { z } from 'zod';
import { attributesFor, recordLabel, resolveObjectType } from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

export const listRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'List'))
    .input(z.object({ objectType: z.string().min(1).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const ot = input.objectType ? await resolveObjectType(ctx.db, input.objectType) : null;
      const rows = await ctx.db.list.findMany({
        where: { deletedAt: null, ...(ot ? { objectTypeId: ot.id } : {}) },
        include: {
          objectType: { select: { apiSlug: true, singular: true, plural: true } },
          _count: { select: { entries: { where: { deletedAt: null } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        description: l.description,
        objectType: l.objectType,
        objectTypeId: l.objectTypeId,
        entryCount: l._count.entries,
      }));
    }),

  get: tenantProcedure
    .use(authorize('read', 'List'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const list = await ctx.db.list.findFirst({
        where: { id: input.id, deletedAt: null },
        include: { objectType: true },
      });
      if (!list) throw new NexusError('NOT_FOUND');
      const defs = await listAttributeDefs(ctx.db, list.id);
      const attrs = await attributesFor(ctx.db, list.objectTypeId);
      const entries = await ctx.db.listEntry.findMany({
        where: { listId: list.id, deletedAt: null },
        include: { record: { select: { id: true, values: true, deletedAt: true } } },
        orderBy: { position: 'asc' },
      });
      return {
        id: list.id,
        name: list.name,
        kind: list.kind,
        description: list.description,
        objectType: {
          id: list.objectType.id,
          apiSlug: list.objectType.apiSlug,
          singular: list.objectType.singular,
          plural: list.objectType.plural,
        },
        stages: stagesOf(defs),
        settings: {
          wipLimits: ((list.settings as Record<string, unknown>)['wipLimits'] ?? {}) as Record<
            string,
            number
          >,
          rotDays: Number((list.settings as Record<string, unknown>)['rotDays'] ?? 14),
        },
        attributes: defs,
        entries: entries
          .filter((e) => !e.record.deletedAt)
          .map((e) => {
            const values = e.values as Record<string, unknown>;
            return {
              id: e.id,
              recordId: e.recordId,
              label: recordLabel(attrs, e.record.values as Record<string, unknown>),
              stage: e.stage,
              position: e.position,
              values,
              enteredStageAt:
                typeof values['enteredStageAt'] === 'string'
                  ? values['enteredStageAt']
                  : e.createdAt.toISOString(),
            };
          }),
      };
    }),

  create: tenantProcedure
    .use(authorize('create', 'List'))
    .input(
      z.object({
        objectType: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        kind: z.enum(['PIPELINE', 'COLLECTION']),
        stages: z.array(optionSchema).max(50).optional(),
        description: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ot = await resolveObjectType(ctx.db, input.objectType);
      const { id } = await createList(ctx.db, ctx.actor, {
        objectTypeId: ot.id,
        name: input.name,
        kind: input.kind,
        stages: input.stages,
        description: input.description,
      });
      await ctx.audit({
        action: 'list.created',
        targetType: 'List',
        targetId: id,
        diff: { name: input.name, kind: input.kind, objectType: ot.apiSlug },
      });
      return { id };
    }),

  update: tenantProcedure
    .use(authorize('update', 'List'))
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).nullable().optional(),
        stages: z.array(optionSchema).min(1).max(50).optional(),
        /** Per-stage WIP limits (§12.2.D); 0 or absent means unlimited. */
        wipLimits: z.record(z.string(), z.number().int().min(0).max(10_000)).optional(),
        /** Days in a stage after which an entry is highlighted as rotting. */
        rotDays: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const list = await ctx.db.list.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!list) throw new NexusError('NOT_FOUND');
      if (input.stages) {
        if (list.kind !== 'PIPELINE')
          throw new NexusError('VALIDATION', {
            context: { reason: 'Only pipelines have stages.' },
          });
        const inUse = await ctx.db.listEntry.groupBy({
          by: ['stage'],
          where: { listId: list.id, deletedAt: null },
        });
        const keep = new Set(input.stages.map((s) => s.id));
        const orphaned = inUse.map((g) => g.stage).filter((s): s is string => !!s && !keep.has(s));
        if (orphaned.length > 0)
          throw new NexusError('POLICY_BLOCKED', {
            context: {
              reason: `Stages still in use: ${orphaned.join(', ')}.`,
              detail: 'Move those entries first.',
            },
          });
        await ctx.db.listAttribute.updateMany({
          where: { listId: list.id, apiSlug: 'stage' },
          data: { config: { options: input.stages } as unknown as Prisma.InputJsonValue },
        });
      }
      await ctx.db.list.update({
        where: { id: list.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          settings: {
            ...(list.settings as Record<string, unknown>),
            ...(input.stages ? { stages: input.stages.map((s) => s.id) } : {}),
            ...(input.wipLimits ? { wipLimits: input.wipLimits } : {}),
            ...(input.rotDays ? { rotDays: input.rotDays } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await ctx.audit({
        action: 'list.updated',
        targetType: 'List',
        targetId: list.id,
        diff: {
          name: input.name,
          stages: input.stages?.map((s) => s.id),
          wipLimits: input.wipLimits,
          rotDays: input.rotDays,
        },
      });
      return { id: list.id };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'List'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const list = await ctx.db.list.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!list) throw new NexusError('NOT_FOUND');
      await ctx.db.list.update({ where: { id: list.id }, data: { deletedAt: new Date() } });
      await ctx.audit({
        action: 'list.deleted',
        targetType: 'List',
        targetId: list.id,
        diff: { name: list.name },
      });
      return { id: list.id };
    }),

  /** Home screen (§12.1 "stalled deals"): pipeline entries nobody has touched in a while, oldest
   * first, across every pipeline. Excludes the default won/lost stage ids — a custom pipeline
   * that doesn't use those ids just won't get this exclusion, a disclosed simplification rather
   * than modeling per-pipeline stage categories here. */
  stalled: tenantProcedure
    .use(authorize('read', 'List'))
    .input(
      z.object({
        days: z.number().int().positive().default(14),
        limit: z.number().int().positive().max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 86_400_000);
      const rows = await ctx.db.listEntry.findMany({
        where: {
          deletedAt: null,
          updatedAt: { lt: since },
          stage: { notIn: ['won', 'lost'] },
          list: { kind: 'PIPELINE', deletedAt: null },
        },
        orderBy: { updatedAt: 'asc' },
        take: input.limit,
        include: {
          list: { select: { id: true, name: true, objectTypeId: true } },
          record: { select: { id: true, values: true } },
        },
      });
      const attrsByObjectType = new Map<string, Awaited<ReturnType<typeof attributesFor>>>();
      const out = [];
      for (const r of rows) {
        let attrs = attrsByObjectType.get(r.list.objectTypeId);
        if (!attrs) {
          attrs = await attributesFor(ctx.db, r.list.objectTypeId);
          attrsByObjectType.set(r.list.objectTypeId, attrs);
        }
        out.push({
          entryId: r.id,
          recordId: r.record.id,
          label: recordLabel(attrs, r.record.values as Record<string, unknown>),
          listId: r.list.id,
          listName: r.list.name,
          stage: r.stage,
          updatedAt: r.updatedAt,
        });
      }
      return out;
    }),
});

export const listEntryRouter = router({
  add: tenantProcedure
    .use(authorize('create', 'ListEntry'))
    .input(
      z.object({
        listId: z.string().uuid(),
        recordId: z.string().uuid(),
        stage: z.string().max(64).optional(),
        values: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const e = await addEntry(ctx.db, ctx.actor, input);
      await ctx.audit({
        action: 'list_entry.added',
        targetType: 'ListEntry',
        targetId: e.id,
        diff: { listId: input.listId, recordId: input.recordId, stage: e.stage },
      });
      await ctx.jobs.dispatch('automate.react', {
        workspaceId: ctx.workspace.id,
        type: 'list.entry_added',
        occurredAt: new Date().toISOString(),
        recordId: input.recordId,
        listId: input.listId,
        entryId: e.id,
        payload: { stage: e.stage },
        causation: { workflowIds: [] },
      });
      // Phase 11 (ADR-022 decision 4): the same event, fanned out to customer webhooks.
      await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
        workspaceId: ctx.workspace.id,
        type: 'list.entry_added',
        recordId: input.recordId,
        listId: input.listId,
        entryId: e.id,
        payload: { stage: e.stage },
      });
      return e;
    }),

  /** Bulk action: add many records to a list; records already present are skipped. */
  addMany: tenantProcedure
    .use(authorize('create', 'ListEntry'))
    .input(
      z.object({
        listId: z.string().uuid(),
        recordIds: z.array(z.string().uuid()).min(1).max(500),
        stage: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let added = 0;
      let skipped = 0;
      for (const recordId of input.recordIds) {
        try {
          await addEntry(ctx.db, ctx.actor, { listId: input.listId, recordId, stage: input.stage });
          added += 1;
        } catch (e) {
          if (NexusError.is(e) && e.code === 'CONFLICT') skipped += 1;
          else throw e;
        }
      }
      await ctx.audit({
        action: 'list_entry.added_many',
        targetType: 'List',
        targetId: input.listId,
        diff: { added, skipped, stage: input.stage ?? null },
      });
      return { added, skipped };
    }),

  move: tenantProcedure
    .use(authorize('update', 'ListEntry'))
    .input(
      z.object({
        entryId: z.string().uuid(),
        stage: z.string().max(64).optional(),
        afterEntryId: z.string().uuid().nullable().optional(),
        beforeEntryId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.listEntry.findFirst({
        where: { id: input.entryId, deletedAt: null },
        select: { stage: true },
      });
      const e = await moveEntry(ctx.db, ctx.actor, input);
      if (input.stage !== undefined && (before?.stage ?? null) !== e.stage) {
        const entry = await ctx.db.listEntry.findFirst({
          where: { id: e.id },
          select: { recordId: true, list: { select: { id: true, name: true, kind: true } } },
        });
        if (entry) {
          await emitTimelineEvent(ctx.db, {
            workspaceId: ctx.workspace.id,
            dedupeKey: `stage:${e.id}:${Date.now()}`,
            type: 'STAGE_CHANGE',
            occurredAt: new Date(),
            recordId: entry.recordId,
            actorUserId: ctx.session.id,
            summary: `Moved to “${e.stage ?? 'no stage'}” in ${entry.list.name}`,
            payload: {
              kind: 'stage_change',
              listId: entry.list.id,
              from: before?.stage ?? null,
              to: e.stage,
            },
          });
          await ctx.jobs.dispatch('automate.react', {
            workspaceId: ctx.workspace.id,
            type: 'list.stage_changed',
            occurredAt: new Date().toISOString(),
            recordId: entry.recordId,
            listId: entry.list.id,
            entryId: e.id,
            payload: { from: before?.stage ?? null, to: e.stage },
            causation: { workflowIds: [] },
          });
          // Phase 11 (ADR-022 decision 4): the same event, fanned out to customer webhooks.
          await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
            workspaceId: ctx.workspace.id,
            type: 'list.stage_changed',
            recordId: entry.recordId,
            listId: entry.list.id,
            entryId: e.id,
            payload: { from: before?.stage ?? null, to: e.stage },
          });
        }
      }
      await ctx.audit({
        action: 'list_entry.moved',
        targetType: 'ListEntry',
        targetId: e.id,
        diff: { stage: { from: before?.stage ?? null, to: e.stage }, position: e.position },
      });
      return e;
    }),

  update: tenantProcedure
    .use(authorize('update', 'ListEntry'))
    .input(z.object({ entryId: z.string().uuid(), values: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      const r = await updateEntryValues(ctx.db, input);
      await ctx.audit({
        action: 'list_entry.updated',
        targetType: 'ListEntry',
        targetId: input.entryId,
        diff: { before: r.before, after: r.after },
      });
      return { id: input.entryId, values: r.after };
    }),

  remove: tenantProcedure
    .use(authorize('update', 'ListEntry'))
    .input(z.object({ entryId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await removeEntry(ctx.db, input.entryId);
      await ctx.audit({
        action: 'list_entry.removed',
        targetType: 'ListEntry',
        targetId: input.entryId,
      });
      return { id: input.entryId };
    }),

  history: tenantProcedure
    .use(authorize('read', 'ListEntry'))
    .input(z.object({ entryId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.listStageHistory.findMany({
        where: { listEntryId: input.entryId },
        include: { changedBy: { select: { name: true, email: true } } },
        orderBy: { at: 'desc' },
      });
      return rows.map((h) => ({
        id: h.id,
        fromStage: h.fromStage,
        toStage: h.toStage,
        at: h.at,
        by: h.changedBy?.name ?? h.changedBy?.email ?? null,
      }));
    }),
});
