/**
 * Canned replies (spec §12.2.A composer): saved answers picked by title or typed as
 * `/shortcut`, optionally limited to one platform.
 */
import { NexusError } from '@nexus/core';
import { Platform } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const platformEnum = z.enum(Object.values(Platform) as [Platform, ...Platform[]]);
const fields = {
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(8000),
  shortcut: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,32}$/i, 'letters, digits, - and _ only')
    .nullable()
    .optional(),
  platform: platformEnum.nullable().optional(),
};

export const cannedReplyRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'CannedReply'))
    .input(z.object({ platform: platformEnum.optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.cannedReply.findMany({
        where: {
          deletedAt: null,
          ...(input.platform ? { OR: [{ platform: null }, { platform: input.platform }] } : {}),
        },
        orderBy: [{ title: 'asc' }],
        include: { createdBy: { select: { name: true, email: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        shortcut: r.shortcut,
        platform: r.platform,
        createdBy: r.createdBy,
        updatedAt: r.updatedAt,
      }));
    }),

  create: tenantProcedure
    .use(authorize('create', 'CannedReply'))
    .input(z.object(fields))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.cannedReply.create({
        data: {
          workspaceId: ctx.workspace.id,
          title: input.title,
          body: input.body,
          shortcut: input.shortcut ? input.shortcut.toLowerCase() : null,
          platform: input.platform ?? null,
          createdById: ctx.session.id,
        },
        select: { id: true },
      });
      await ctx.audit({
        action: 'canned_reply.created',
        targetType: 'CannedReply',
        targetId: row.id,
        diff: { title: input.title },
      });
      return row;
    }),

  update: tenantProcedure
    .use(authorize('update', 'CannedReply'))
    .input(
      z.object({
        id: z.string().uuid(),
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.cannedReply.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!before) throw new NexusError('NOT_FOUND');
      const { id: _id, ...patch } = input as {
        id: string;
        title?: string;
        body?: string;
        shortcut?: string | null;
        platform?: Platform | null;
      };
      await ctx.db.cannedReply.update({
        where: { id: before.id },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.shortcut !== undefined
            ? { shortcut: patch.shortcut ? patch.shortcut.toLowerCase() : null }
            : {}),
          ...(patch.platform !== undefined ? { platform: patch.platform } : {}),
        },
      });
      await ctx.audit({
        action: 'canned_reply.updated',
        targetType: 'CannedReply',
        targetId: before.id,
        diff: patch,
      });
      return { id: before.id };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'CannedReply'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.cannedReply.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!before) throw new NexusError('NOT_FOUND');
      await ctx.db.cannedReply.update({
        where: { id: before.id },
        data: { deletedAt: new Date(), shortcut: null },
      });
      await ctx.audit({
        action: 'canned_reply.deleted',
        targetType: 'CannedReply',
        targetId: before.id,
      });
      return { id: before.id };
    }),
});
