import { NexusError } from '@nexus/core';
import { emitTimelineEvent } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

/** Notes on a record (§12.2.B). Plain text in Phase 3; rich text lands with the inbox. */
export const noteRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Note'))
    .input(z.object({ recordId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.note.findMany({
        where: { recordId: input.recordId, deletedAt: null },
        include: { author: { select: { id: true, name: true, email: true } } },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      });
      return rows.map((n) => ({
        id: n.id,
        body: n.body,
        pinned: n.pinned,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        author: n.author,
        isMine: n.authorId === ctx.session.id,
      }));
    }),

  create: tenantProcedure
    .use(authorize('create', 'Note'))
    .input(z.object({ recordId: z.string().uuid(), body: z.string().trim().min(1).max(20_000) }))
    .mutation(async ({ ctx, input }) => {
      const record = await ctx.db.record.findFirst({
        where: { id: input.recordId, deletedAt: null },
        select: { id: true },
      });
      if (!record) throw new NexusError('NOT_FOUND');
      const note = await ctx.db.note.create({
        data: {
          workspaceId: ctx.workspace.id,
          recordId: record.id,
          authorId: ctx.session.id,
          body: input.body,
        },
      });
      await emitTimelineEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        dedupeKey: `note:${note.id}`,
        type: 'NOTE',
        occurredAt: note.createdAt,
        recordId: record.id,
        actorUserId: ctx.session.id,
        summary: `Added a note: “${input.body.length > 140 ? `${input.body.slice(0, 139)}…` : input.body}”`,
        payload: { kind: 'note', noteId: note.id },
      });
      await ctx.audit({
        action: 'note.created',
        targetType: 'Note',
        targetId: note.id,
        diff: { recordId: record.id },
      });
      return { id: note.id };
    }),

  update: tenantProcedure
    .use(authorize('update', 'Note'))
    .input(
      z.object({
        id: z.string().uuid(),
        body: z.string().trim().min(1).max(20_000).optional(),
        pinned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.note.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!note) throw new NexusError('NOT_FOUND');
      if (note.authorId !== ctx.session.id && !ctx.ability.can('manage', 'Note')) {
        throw new NexusError('FORBIDDEN', {
          context: { reason: 'You can only edit your own notes.' },
        });
      }
      await ctx.db.note.update({
        where: { id: note.id },
        data: {
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        },
      });
      await ctx.audit({
        action: 'note.updated',
        targetType: 'Note',
        targetId: note.id,
        diff: { pinned: input.pinned, edited: input.body !== undefined },
      });
      return { id: note.id };
    }),

  delete: tenantProcedure
    .use(authorize('update', 'Note'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.note.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!note) throw new NexusError('NOT_FOUND');
      if (note.authorId !== ctx.session.id && !ctx.ability.can('manage', 'Note')) {
        throw new NexusError('FORBIDDEN', {
          context: { reason: 'You can only delete your own notes.' },
        });
      }
      await ctx.db.note.update({ where: { id: note.id }, data: { deletedAt: new Date() } });
      await ctx.audit({ action: 'note.deleted', targetType: 'Note', targetId: note.id });
      return { id: note.id };
    }),
});
