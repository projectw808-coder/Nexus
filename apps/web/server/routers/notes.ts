import { NexusError } from '@nexus/core';
import { emitTimelineEvent, publishEvent } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

/** Notes on a record (§12.2.B). Plain text in Phase 3; rich text lands with the inbox. */
export const noteRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Note'))
    .input(
      z
        .object({
          recordId: z.string().uuid().optional(),
          conversationId: z.string().uuid().optional(),
        })
        .refine((v) => Boolean(v.recordId) !== Boolean(v.conversationId), {
          message: 'Pass exactly one of recordId or conversationId.',
        }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.note.findMany({
        where: {
          ...(input.recordId
            ? { recordId: input.recordId }
            : { conversationId: input.conversationId }),
          deletedAt: null,
        },
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
        mentions: (n.bodyJson as { mentions?: string[] } | null)?.mentions ?? [],
      }));
    }),

  create: tenantProcedure
    .use(authorize('create', 'Note'))
    .input(
      z
        .object({
          recordId: z.string().uuid().optional(),
          /** An internal note on a thread (§12.2.A); lands on the person's timeline when resolved. */
          conversationId: z.string().uuid().optional(),
          body: z.string().trim().min(1).max(20_000),
          /** Teammates @mentioned in the body (user ids). */
          mentions: z.array(z.string().uuid()).max(20).default([]),
        })
        .refine((v) => Boolean(v.recordId) !== Boolean(v.conversationId), {
          message: 'Pass exactly one of recordId or conversationId.',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      let recordId: string | null = null;
      let identityId: string | null = null;
      if (input.recordId) {
        const record = await ctx.db.record.findFirst({
          where: { id: input.recordId, deletedAt: null },
          select: { id: true },
        });
        if (!record) throw new NexusError('NOT_FOUND');
        recordId = record.id;
      } else {
        const conv = await ctx.db.conversation.findFirst({
          where: { id: input.conversationId!, deletedAt: null },
          select: { id: true, personRecordId: true, identityId: true },
        });
        if (!conv) throw new NexusError('NOT_FOUND');
        recordId = conv.personRecordId;
        identityId = conv.identityId;
      }
      if (input.mentions.length) {
        const members = await ctx.db.membership.count({
          where: { userId: { in: input.mentions }, deletedAt: null },
        });
        if (members !== new Set(input.mentions).size)
          throw new NexusError('VALIDATION', {
            context: { reason: 'Only workspace members can be mentioned.' },
          });
      }
      const note = await ctx.db.note.create({
        data: {
          workspaceId: ctx.workspace.id,
          recordId: input.recordId ?? null,
          conversationId: input.conversationId ?? null,
          authorId: ctx.session.id,
          body: input.body,
          ...(input.mentions.length ? { bodyJson: { mentions: input.mentions } } : {}),
        },
      });
      if (input.conversationId)
        await publishEvent(ctx.db, {
          workspaceId: ctx.workspace.id,
          topic: 'conversation.changed',
          payload: { ids: [input.conversationId], field: 'notes' },
        });
      await emitTimelineEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        dedupeKey: `note:${note.id}`,
        type: 'NOTE',
        occurredAt: note.createdAt,
        recordId,
        identityId,
        actorUserId: ctx.session.id,
        summary: `Added a note: “${input.body.length > 140 ? `${input.body.slice(0, 139)}…` : input.body}”`,
        payload: {
          kind: 'note',
          noteId: note.id,
          conversationId: input.conversationId ?? null,
          mentions: input.mentions,
        },
      });
      await ctx.audit({
        action: 'note.created',
        targetType: 'Note',
        targetId: note.id,
        diff: { recordId, conversationId: input.conversationId ?? null, mentions: input.mentions },
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
