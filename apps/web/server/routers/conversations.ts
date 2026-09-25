/**
 * Conversations (spec §6.3, Phase 5 "bare conversation list"): list threads with their last
 * message and messaging window, read one thread, reply through the outbound flow (§9.3), and
 * open/close. The full inbox (assignment, snooze, SLA, keyboard triage) is Phase 7.
 */
import { NexusError } from '@nexus/core';
import { requestReply } from '@nexus/sync';
import { z } from 'zod';
import { authorize, router, tenantJobProcedure, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });

export const conversationRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Conversation'))
    .input(
      z
        .object({
          status: z.enum(['OPEN', 'SNOOZED', 'CLOSED', 'SPAM']).optional(),
          connectionId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.conversation.findMany({
        where: {
          deletedAt: null,
          ...(input.status ? { status: input.status } : { status: { in: ['OPEN', 'SNOOZED'] } }),
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        },
        orderBy: { lastMessageAt: 'desc' },
        take: input.limit,
        include: {
          identity: {
            select: {
              id: true,
              displayName: true,
              handle: true,
              avatarUrl: true,
              externalId: true,
            },
          },
          connection: { select: { id: true, label: true, platform: true, status: true } },
          messages: {
            where: { deletedAt: null },
            orderBy: { sentAt: 'desc' },
            take: 1,
            select: { body: true, direction: true, sentAt: true, replyWindowExpiresAt: true },
          },
        },
      });
      return rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        subject: c.subject,
        platform: c.platform,
        connection: c.connection,
        identity: c.identity,
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        lastMessage: c.messages[0] ?? null,
        parentExternalId: c.parentExternalId,
      }));
    }),

  get: tenantProcedure
    .use(authorize('read', 'Conversation'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const c = await ctx.db.conversation.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          identity: true,
          connection: { select: { id: true, label: true, platform: true, status: true } },
          messages: {
            where: { deletedAt: null },
            orderBy: { sentAt: 'asc' },
            include: {
              authorUser: { select: { id: true, name: true, email: true } },
              outboundAction: {
                select: { id: true, status: true, errorCode: true, errorMessage: true },
              },
            },
          },
        },
      });
      if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
      const lastInbound = [...c.messages].reverse().find((m) => m.direction === 'INBOUND') ?? null;
      const connector = ctx.sync.registry.tryGet(c.platform);
      const windowHours = connector?.manifest.messagingWindowHours ?? null;
      const replyWindowExpiresAt =
        c.kind === 'DM' && lastInbound
          ? (lastInbound.replyWindowExpiresAt ??
            (windowHours ? new Date(lastInbound.sentAt.getTime() + windowHours * 3600_000) : null))
          : null;
      return {
        id: c.id,
        kind: c.kind,
        status: c.status,
        subject: c.subject,
        platform: c.platform,
        connection: c.connection,
        identity: c.identity,
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        parentExternalId: c.parentExternalId,
        replyWindowExpiresAt,
        windowHours,
        canReply:
          ctx.ability.can('update', 'Conversation') &&
          (c.connection.status === 'CONNECTED' || c.connection.status === 'DEGRADED'),
        messages: c.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.body,
          attachments: m.attachments,
          sentAt: m.sentAt,
          deliveryState: m.deliveryState,
          failureHint: m.failureHint,
          authorUser: m.authorUser,
          outboundAction: m.outboundAction,
        })),
      };
    }),

  /**
   * Reply. Runs outside the ambient transaction (tenantJobProcedure) because the outbound flow
   * opens its own: preflight → OutboundAction → queue. A blocked send returns the reason
   * rather than throwing, so the composer can show it inline.
   */
  reply: tenantJobProcedure
    .use(authorize('update', 'Conversation'))
    .input(
      id.extend({
        text: z.string().trim().min(1).max(4000),
        requestNonce: z.string().min(8).max(64),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const outcome = await requestReply(ctx.sync, {
        actor: ctx.actor,
        conversationId: input.id,
        text: input.text,
        requestNonce: input.requestNonce,
      });
      await ctx.audit({
        action: `conversation.reply_${outcome.status}`,
        targetType: 'Conversation',
        targetId: input.id,
        diff: {
          outboundActionId: outcome.outboundActionId,
          ...(outcome.status === 'blocked' ? { code: outcome.code, reason: outcome.reason } : {}),
        },
      });
      return outcome;
    }),

  setStatus: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id.extend({ status: z.enum(['OPEN', 'CLOSED', 'SPAM']) }))
    .mutation(async ({ ctx, input }) => {
      const c = await ctx.db.conversation.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
      await ctx.db.conversation.update({
        where: { id: c.id },
        data: { status: input.status, ...(input.status === 'OPEN' ? {} : { unreadCount: 0 }) },
      });
      await ctx.audit({
        action: 'conversation.status_changed',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { from: c.status, to: input.status },
      });
      return { id: c.id, status: input.status };
    }),

  markRead: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const c = await ctx.db.conversation.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, unreadCount: true },
      });
      if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
      if (c.unreadCount > 0)
        await ctx.db.conversation.update({ where: { id: c.id }, data: { unreadCount: 0 } });
      await ctx.audit({
        action: 'conversation.read',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { unread: c.unreadCount },
      });
      return { id: c.id };
    }),
});
