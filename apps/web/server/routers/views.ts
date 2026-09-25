import { NexusError, filterSchema, sortSchema } from '@nexus/core';
import type { Prisma } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const viewFields = {
  name: z.string().trim().min(1).max(80),
  layout: z.enum(['TABLE', 'BOARD', 'CALENDAR', 'TIMELINE']).default('TABLE'),
  isShared: z.boolean().default(false),
  columns: z.array(z.string().max(64)).max(100).default([]),
  /** Record filters, or (inbox views) the conversation filter state as an object. */
  filters: z.union([z.array(filterSchema).max(20), z.record(z.string(), z.unknown())]).default([]),
  sorts: z.array(sortSchema).max(3).default([]),
};

/** Saved views (§6.6): per object or list, shared or private (owner-only). */
export const viewRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'SavedView'))
    .input(
      z
        .object({
          objectTypeId: z.string().uuid().optional(),
          listId: z.string().uuid().optional(),
          /** Inbox views belong to neither an object nor a list. */
          scope: z.enum(['inbox']).optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.savedView.findMany({
        where: {
          deletedAt: null,
          ...(input.scope === 'inbox' ? { objectTypeId: null, listId: null } : {}),
          ...(input.objectTypeId ? { objectTypeId: input.objectTypeId } : {}),
          ...(input.listId ? { listId: input.listId } : {}),
          OR: [{ isShared: true }, { ownerId: ctx.session.id }],
        },
        orderBy: [{ isShared: 'desc' }, { position: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map((v) => ({
        id: v.id,
        name: v.name,
        layout: v.layout,
        isShared: v.isShared,
        isMine: v.ownerId === ctx.session.id,
        columns: v.columns,
        filters: v.filters,
        sorts: v.sorts,
        objectTypeId: v.objectTypeId,
        listId: v.listId,
      }));
    }),

  create: tenantProcedure
    .use(authorize('create', 'SavedView'))
    .input(
      z.object({
        objectTypeId: z.string().uuid().optional(),
        listId: z.string().uuid().optional(),
        /** Inbox views belong to neither (ADR-018). */
        scope: z.enum(['inbox']).optional(),
        ...viewFields,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.objectTypeId && !input.listId && input.scope !== 'inbox')
        throw new NexusError('VALIDATION', {
          context: { reason: 'A view belongs to an object or a list.' },
        });
      if (input.isShared && !ctx.ability.can('update', 'ObjectType')) {
        throw new NexusError('FORBIDDEN', {
          context: { reason: 'Only admins can create shared views.' },
        });
      }
      const row = await ctx.db.savedView.create({
        data: {
          workspaceId: ctx.workspace.id,
          objectTypeId: input.objectTypeId ?? null,
          listId: input.listId ?? null,
          ownerId: ctx.session.id,
          name: input.name,
          layout: input.layout,
          isShared: input.isShared,
          columns: input.columns,
          filters: input.filters as unknown as Prisma.InputJsonValue,
          sorts: input.sorts as unknown as Prisma.InputJsonValue,
        },
      });
      await ctx.audit({
        action: 'view.created',
        targetType: 'SavedView',
        targetId: row.id,
        diff: { name: row.name, isShared: row.isShared },
      });
      return { id: row.id };
    }),

  update: tenantProcedure
    .use(authorize('update', 'SavedView'))
    .input(
      z.object({
        id: z.string().uuid(),
        name: viewFields.name.optional(),
        layout: viewFields.layout.optional(),
        isShared: z.boolean().optional(),
        columns: viewFields.columns.optional(),
        filters: viewFields.filters.optional(),
        sorts: viewFields.sorts.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const view = await ctx.db.savedView.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!view) throw new NexusError('NOT_FOUND');
      const mine = view.ownerId === ctx.session.id;
      if (!mine && !ctx.ability.can('update', 'ObjectType'))
        throw new NexusError('FORBIDDEN', {
          context: { reason: 'You can only edit your own views.' },
        });
      if (input.isShared === true && !ctx.ability.can('update', 'ObjectType'))
        throw new NexusError('FORBIDDEN', { context: { reason: 'Only admins can share views.' } });
      const { id, ...rest } = input;
      await ctx.db.savedView.update({
        where: { id },
        data: {
          ...(rest.name !== undefined ? { name: rest.name } : {}),
          ...(rest.layout !== undefined ? { layout: rest.layout } : {}),
          ...(rest.isShared !== undefined ? { isShared: rest.isShared } : {}),
          ...(rest.columns !== undefined ? { columns: rest.columns } : {}),
          ...(rest.filters !== undefined
            ? { filters: rest.filters as unknown as Prisma.InputJsonValue }
            : {}),
          ...(rest.sorts !== undefined
            ? { sorts: rest.sorts as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      await ctx.audit({
        action: 'view.updated',
        targetType: 'SavedView',
        targetId: id,
        diff: rest,
      });
      return { id };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'SavedView'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const view = await ctx.db.savedView.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!view) throw new NexusError('NOT_FOUND');
      if (view.ownerId !== ctx.session.id && !ctx.ability.can('update', 'ObjectType'))
        throw new NexusError('FORBIDDEN', {
          context: { reason: 'You can only delete your own views.' },
        });
      await ctx.db.savedView.update({ where: { id: view.id }, data: { deletedAt: new Date() } });
      await ctx.audit({
        action: 'view.deleted',
        targetType: 'SavedView',
        targetId: view.id,
        diff: { name: view.name },
      });
      return { id: view.id };
    }),
});
