/**
 * Reports (§12.2.E): dashboards, their widgets, and executing a widget's saved query.
 *
 * CRUD lives here; the queries themselves live in `@nexus/db`'s `reports/` and the drawing in
 * `components/charts`. A widget's `query` column is unconstrained JSON in the schema, so every
 * read and every write parses it through `@nexus/core`'s `widgetQuerySchema` — an invalid or
 * stale query becomes a designed error, never a crashed dashboard.
 */
import {
  NexusError,
  WIDGET_KINDS,
  kindAcceptsSource,
  parseWidgetQuery,
  type WidgetKind,
} from '@nexus/core';
import { executeWidgetQuery, type Prisma } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const asJson = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as never;

const widgetKind = z.enum(WIDGET_KINDS);

/** Parse a stored query, naming the widget in the error so the UI can point at the right tile. */
function queryOf(raw: unknown, what: string) {
  const parsed = parseWidgetQuery(raw);
  if (!parsed.ok) {
    throw new NexusError('VALIDATION', {
      context: {
        reason: `${what} has a saved query this version cannot read.`,
        detail: 'Edit the widget and pick its data source again.',
      },
      details: { issues: parsed.issues },
    });
  }
  return parsed.query;
}

function checkPairing(kind: WidgetKind, source: string): void {
  if (!kindAcceptsSource(kind, source as never)) {
    throw new NexusError('VALIDATION', {
      context: {
        reason: `A ${kind.toLowerCase().replace('_', ' ')} cannot draw "${source}" data.`,
        detail: 'Pick a data source that matches the widget kind.',
      },
    });
  }
}

const widgetSelect = {
  id: true,
  dashboardId: true,
  kind: true,
  title: true,
  query: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const dashboardRouter = router({
  list: tenantProcedure.use(authorize('read', 'Dashboard')).query(async ({ ctx }) => {
    return ctx.db.dashboard.findMany({
      where: { deletedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        isDefault: true,
        isShared: true,
        ownerId: true,
        position: true,
        _count: { select: { widgets: { where: { deletedAt: null } } } },
      },
    });
  }),

  get: tenantProcedure
    .use(authorize('read', 'Dashboard'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.dashboard.findFirst({
        where: { id: input.id, deletedAt: null },
        select: {
          id: true,
          name: true,
          description: true,
          isDefault: true,
          isShared: true,
          ownerId: true,
          position: true,
          widgets: {
            where: { deletedAt: null },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            select: widgetSelect,
          },
        },
      });
      if (!row) throw new NexusError('NOT_FOUND', { context: { reason: 'Dashboard not found.' } });
      return row;
    }),

  create: tenantProcedure
    .use(authorize('create', 'Dashboard'))
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        isShared: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const last = await ctx.db.dashboard.findFirst({
        where: { deletedAt: null },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const row = await ctx.db.dashboard.create({
        data: {
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description ?? null,
          isShared: input.isShared,
          ownerId: ctx.session.id,
          position: (last?.position ?? -1) + 1,
        },
        select: { id: true, name: true },
      });
      await ctx.audit({
        action: 'dashboard.created',
        targetType: 'Dashboard',
        targetId: row.id,
        diff: { name: input.name },
      });
      return row;
    }),

  update: tenantProcedure
    .use(authorize('update', 'Dashboard'))
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        isShared: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const existing = await ctx.db.dashboard.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing)
        throw new NexusError('NOT_FOUND', { context: { reason: 'Dashboard not found.' } });
      // Exactly one default per workspace, so "the dashboard" always resolves.
      if (patch.isDefault === true) {
        await ctx.db.dashboard.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      const row = await ctx.db.dashboard.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.isShared !== undefined ? { isShared: patch.isShared } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        },
        select: { id: true, name: true },
      });
      await ctx.audit({
        action: 'dashboard.updated',
        targetType: 'Dashboard',
        targetId: id,
        diff: patch,
      });
      return row;
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'Dashboard'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const hit = await ctx.db.dashboard.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: now },
      });
      if (hit.count === 0)
        throw new NexusError('NOT_FOUND', { context: { reason: 'Dashboard not found.' } });
      await ctx.db.dashboardWidget.updateMany({
        where: { dashboardId: input.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await ctx.audit({
        action: 'dashboard.deleted',
        targetType: 'Dashboard',
        targetId: input.id,
      });
      return { id: input.id };
    }),
});

export const widgetRouter = router({
  create: tenantProcedure
    .use(authorize('create', 'Dashboard'))
    .input(
      z.object({
        dashboardId: z.string().uuid(),
        kind: widgetKind,
        title: z.string().trim().min(1).max(200),
        query: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dashboard = await ctx.db.dashboard.findFirst({
        where: { id: input.dashboardId, deletedAt: null },
        select: { id: true },
      });
      if (!dashboard)
        throw new NexusError('NOT_FOUND', { context: { reason: 'Dashboard not found.' } });
      const query = queryOf(input.query, 'This widget');
      checkPairing(input.kind, query.source);
      const last = await ctx.db.dashboardWidget.findFirst({
        where: { dashboardId: input.dashboardId, deletedAt: null },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const row = await ctx.db.dashboardWidget.create({
        data: {
          workspaceId: ctx.workspace.id,
          dashboardId: input.dashboardId,
          kind: input.kind,
          title: input.title,
          query: asJson(query),
          position: (last?.position ?? -1) + 1,
        },
        select: widgetSelect,
      });
      await ctx.audit({
        action: 'dashboard.widget_created',
        targetType: 'DashboardWidget',
        targetId: row.id,
        diff: { kind: input.kind, title: input.title, source: query.source },
      });
      return row;
    }),

  update: tenantProcedure
    .use(authorize('update', 'Dashboard'))
    .input(
      z.object({
        id: z.string().uuid(),
        kind: widgetKind.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        query: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.dashboardWidget.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, kind: true, query: true },
      });
      if (!existing)
        throw new NexusError('NOT_FOUND', { context: { reason: 'Widget not found.' } });
      const kind = input.kind ?? existing.kind;
      const query =
        input.query === undefined
          ? queryOf(existing.query, 'This widget')
          : queryOf(input.query, 'This widget');
      checkPairing(kind, query.source);
      const row = await ctx.db.dashboardWidget.update({
        where: { id: input.id },
        data: {
          kind,
          ...(input.title !== undefined ? { title: input.title } : {}),
          query: asJson(query),
        },
        select: widgetSelect,
      });
      await ctx.audit({
        action: 'dashboard.widget_updated',
        targetType: 'DashboardWidget',
        targetId: input.id,
        diff: { kind, source: query.source, ...(input.title ? { title: input.title } : {}) },
      });
      return row;
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'Dashboard'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const hit = await ctx.db.dashboardWidget.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (hit.count === 0)
        throw new NexusError('NOT_FOUND', { context: { reason: 'Widget not found.' } });
      await ctx.audit({
        action: 'dashboard.widget_deleted',
        targetType: 'DashboardWidget',
        targetId: input.id,
      });
      return { id: input.id };
    }),

  /** Whole-dashboard reorder: the ids in their new order, positions rewritten to match. */
  reorder: tenantProcedure
    .use(authorize('update', 'Dashboard'))
    .input(
      z.object({
        dashboardId: z.string().uuid(),
        orderedIds: z.array(z.string().uuid()).min(1).max(60),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.db.dashboardWidget.findMany({
        where: { dashboardId: input.dashboardId, deletedAt: null },
        select: { id: true },
      });
      const known = new Set(owned.map((w) => w.id));
      if (input.orderedIds.some((id) => !known.has(id)) || input.orderedIds.length !== known.size) {
        throw new NexusError('VALIDATION', {
          context: { reason: 'The order must list every widget on this dashboard exactly once.' },
        });
      }
      for (const [position, id] of input.orderedIds.entries()) {
        await ctx.db.dashboardWidget.update({ where: { id }, data: { position } });
      }
      await ctx.audit({
        action: 'dashboard.widgets_reordered',
        targetType: 'Dashboard',
        targetId: input.dashboardId,
        diff: { order: input.orderedIds },
      });
      return { ok: true };
    }),

  /**
   * Execute a widget's query and return the result shaped for its chart. Either by widget id
   * (the dashboard) or by an unsaved kind + query (the add-widget form's live preview).
   */
  data: tenantProcedure
    .use(authorize('read', 'Dashboard'))
    .input(
      z.union([
        z.object({ widgetId: z.string().uuid() }),
        z.object({ kind: widgetKind, query: z.unknown() }),
      ]),
    )
    .query(async ({ ctx, input }) => {
      let kind: WidgetKind;
      let rawQuery: unknown;
      let title: string | null = null;
      if ('widgetId' in input) {
        const widget = await ctx.db.dashboardWidget.findFirst({
          where: { id: input.widgetId, deletedAt: null },
          select: { kind: true, query: true, title: true },
        });
        if (!widget)
          throw new NexusError('NOT_FOUND', { context: { reason: 'Widget not found.' } });
        kind = widget.kind;
        rawQuery = widget.query;
        title = widget.title;
      } else {
        kind = input.kind;
        rawQuery = input.query;
      }
      const query = queryOf(rawQuery, title ? `"${title}"` : 'This widget');
      checkPairing(kind, query.source);
      const result = await executeWidgetQuery({ db: ctx.db, workspaceId: ctx.workspace.id }, query);
      return { kind, title, result };
    }),
});
