/**
 * Conversations — the unified inbox (spec §6.3, §12.2.A). The list is cursor-paged and
 * indexed on (workspace, status, lastMessageAt); filters cover platform, assignee, status, SLA,
 * unread, kind and tag; tab counts come back with every page. Every mutation publishes a
 * `conversation.changed` event so other tabs and teammates see it live, and writes its audit
 * row. Replies go through the outbound flow (§9.3); a blocked send returns its reason.
 */
import { NexusError } from '@nexus/core';
import {
  ConversationKind,
  Platform,
  publishEvent,
  queryTimeline,
  type Prisma,
  type TenantDb,
} from '@nexus/db';
import { requestReply } from '@nexus/sync';
import { z } from 'zod';
import { identitySummary, personLabels } from '../identity-helpers';
import { attributesFor, recordLabel } from '../objects-helpers';
import { authorize, router, tenantJobProcedure, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });
const statusEnum = z.enum(['OPEN', 'SNOOZED', 'CLOSED', 'SPAM']);
const platformEnum = z.enum(Object.values(Platform) as [Platform, ...Platform[]]);
const kindEnum = z.enum(
  Object.values(ConversationKind) as [ConversationKind, ...ConversationKind[]],
);
const tagSchema = z.string().trim().min(1).max(32);

const listInput = z.object({
  status: statusEnum.default('OPEN'),
  platform: platformEnum.optional(),
  connectionId: z.string().uuid().optional(),
  kind: kindEnum.optional(),
  /** `me`, `unassigned`, `anyone` or a user id. */
  assignee: z.string().max(64).optional(),
  unread: z.boolean().optional(),
  sla: z.enum(['breached', 'due_soon', 'any']).optional(),
  tag: tagSchema.optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ConversationListInput = z.infer<typeof listInput>;

const DUE_SOON_MS = 30 * 60_000;

function encodeCursor(at: Date, cid: string): string {
  return Buffer.from(`${at.toISOString()}|${cid}`, 'utf8').toString('base64url');
}
function decodeCursor(c: string | null | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [iso, cid] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!iso || !cid) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id: cid };
}

function whereFor(
  input: ConversationListInput,
  selfId: string,
  now: Date,
): Prisma.ConversationWhereInput {
  const where: Prisma.ConversationWhereInput = { deletedAt: null, status: input.status };
  if (input.platform) where.platform = input.platform;
  if (input.connectionId) where.connectionId = input.connectionId;
  if (input.kind) where.kind = input.kind;
  if (input.assignee === 'me') where.assigneeId = selfId;
  else if (input.assignee === 'unassigned') where.assigneeId = null;
  else if (input.assignee && input.assignee !== 'anyone') where.assigneeId = input.assignee;
  if (input.unread) where.unreadCount = { gt: 0 };
  if (input.sla === 'breached') where.slaDueAt = { lt: now };
  else if (input.sla === 'due_soon')
    where.slaDueAt = { gte: now, lte: new Date(now.getTime() + DUE_SOON_MS) };
  else if (input.sla === 'any') where.slaDueAt = { not: null };
  if (input.tag) where.tags = { has: input.tag };
  if (input.search) {
    const q = input.search;
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { identity: { displayName: { contains: q, mode: 'insensitive' } } },
      { identity: { handle: { contains: q, mode: 'insensitive' } } },
      { messages: { some: { body: { contains: q, mode: 'insensitive' }, deletedAt: null } } },
    ];
  }
  return where;
}

const LIST_INCLUDE = {
  identity: {
    select: {
      id: true,
      displayName: true,
      handle: true,
      avatarUrl: true,
      externalId: true,
      platform: true,
    },
  },
  connection: { select: { id: true, label: true, platform: true, status: true } },
  assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
  messages: {
    where: { deletedAt: null },
    orderBy: { sentAt: 'desc' as const },
    take: 1,
    select: { body: true, direction: true, sentAt: true, replyWindowExpiresAt: true },
  },
} satisfies Prisma.ConversationInclude;

type ListRow = Prisma.ConversationGetPayload<{ include: typeof LIST_INCLUDE }>;

function listItem(c: ListRow, personLabel: string | null) {
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    subject: c.subject,
    platform: c.platform,
    connection: c.connection,
    identity: c.identity,
    person: c.personRecordId ? { id: c.personRecordId, label: personLabel ?? '(person)' } : null,
    assignee: c.assignee,
    tags: c.tags,
    snoozedUntil: c.snoozedUntil,
    slaDueAt: c.slaDueAt,
    firstResponseAt: c.firstResponseAt,
    lastMessageAt: c.lastMessageAt,
    unreadCount: c.unreadCount,
    lastMessage: c.messages[0] ?? null,
    parentExternalId: c.parentExternalId,
  };
}

async function loadConversation(db: TenantDb, cid: string) {
  const c = await db.conversation.findFirst({
    where: { id: cid, deletedAt: null },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      tags: true,
      snoozedUntil: true,
      unreadCount: true,
      personRecordId: true,
      identityId: true,
      connectionId: true,
    },
  });
  if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
  return c;
}

export const conversationRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Conversation'))
    .input(listInput.default({ status: 'OPEN', limit: 50 }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const where = whereFor(input, ctx.session.id, now);
      const cursor = decodeCursor(input.cursor);
      const rows = await ctx.db.conversation.findMany({
        where: cursor
          ? {
              AND: [
                where,
                {
                  OR: [
                    { lastMessageAt: { lt: cursor.at } },
                    { lastMessageAt: cursor.at, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : where,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        include: LIST_INCLUDE,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      // Tab counts ignore the platform filter (so every tab shows its number) but keep the rest.
      const { platform: _p, connectionId: _c, ...rest } = input;
      const countWhere = whereFor({ ...rest, limit: input.limit }, ctx.session.id, now);
      const [byPlatform, unread, breached] = await Promise.all([
        ctx.db.conversation.groupBy({
          by: ['platform'],
          where: countWhere,
          _count: { _all: true },
        }),
        ctx.db.conversation.count({ where: { ...countWhere, unreadCount: { gt: 0 } } }),
        ctx.db.conversation.count({ where: { ...countWhere, slaDueAt: { lt: now } } }),
      ]);
      const labels = await personLabels(
        ctx.db,
        page.flatMap((c) => (c.personRecordId ? [c.personRecordId] : [])),
      );
      return {
        items: page.map((c) =>
          listItem(c, c.personRecordId ? (labels.get(c.personRecordId)?.label ?? null) : null),
        ),
        nextCursor:
          rows.length > input.limit && last ? encodeCursor(last.lastMessageAt, last.id) : null,
        counts: {
          total: byPlatform.reduce((a, g) => a + g._count._all, 0),
          byPlatform: Object.fromEntries(byPlatform.map((g) => [g.platform, g._count._all])),
          unread,
          breached,
        },
      };
    }),

  get: tenantProcedure
    .use(authorize('read', 'Conversation'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const c = await ctx.db.conversation.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          identity: true,
          connection: {
            select: { id: true, label: true, platform: true, status: true, accountName: true },
          },
          assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
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
          notes: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { author: { select: { id: true, name: true, email: true } } },
          },
        },
      });
      if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
      const lastInbound = [...c.messages].reverse().find((m) => m.direction === 'INBOUND') ?? null;
      const connector = ctx.sync.registry.tryGet(c.platform);
      const manifest = connector?.manifest ?? null;
      const windowHours = manifest?.messagingWindowHours ?? null;
      const replyWindowExpiresAt =
        c.kind === 'DM' && lastInbound
          ? (lastInbound.replyWindowExpiresAt ??
            (windowHours ? new Date(lastInbound.sentAt.getTime() + windowHours * 3600_000) : null))
          : null;
      const labels = await personLabels(ctx.db, c.personRecordId ? [c.personRecordId] : []);
      const limits = manifest?.outboundLimits ?? null;
      return {
        id: c.id,
        kind: c.kind,
        status: c.status,
        subject: c.subject,
        platform: c.platform,
        connection: c.connection,
        identity: c.identity ? identitySummary(c.identity) : null,
        person: c.personRecordId
          ? { id: c.personRecordId, label: labels.get(c.personRecordId)?.label ?? '(person)' }
          : null,
        assignee: c.assignee,
        tags: c.tags,
        snoozedUntil: c.snoozedUntil,
        slaDueAt: c.slaDueAt,
        firstResponseAt: c.firstResponseAt,
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        parentExternalId: c.parentExternalId,
        replyWindowExpiresAt,
        windowHours,
        canReply:
          ctx.ability.can('update', 'Conversation') &&
          (c.connection.status === 'CONNECTED' || c.connection.status === 'DEGRADED'),
        composer: {
          maxChars: c.kind === 'DM' ? (limits?.dm ?? null) : (limits?.comment ?? null),
          attachmentTypes: manifest?.outboundAttachmentTypes ?? [],
          sendAs: c.connection.label,
        },
        messages: c.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.body,
          attachments: m.attachments,
          sentAt: m.sentAt,
          deliveryState: m.deliveryState,
          failureHint: m.failureHint,
          sourceUrl: m.sourceUrl,
          authorUser: m.authorUser,
          outboundAction: m.outboundAction,
        })),
        notes: c.notes.map((n) => ({
          id: n.id,
          body: n.body,
          createdAt: n.createdAt,
          author: n.author,
          mentions: (n.bodyJson as { mentions?: string[] } | null)?.mentions ?? [],
        })),
      };
    }),

  /** The context sidebar: the resolved person, their channel identities, open deals, recent history. */
  context: tenantProcedure
    .use(authorize('read', 'Conversation'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const c = await ctx.db.conversation.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, personRecordId: true, identityId: true, identity: true },
      });
      if (!c) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
      const personId = c.personRecordId;
      const labels = await personLabels(ctx.db, personId ? [personId] : []);
      const identities = personId
        ? await ctx.db.identity.findMany({
            where: { personRecordId: personId, deletedAt: null },
            orderBy: { lastSeenAt: 'desc' },
          })
        : c.identity
          ? [c.identity]
          : [];
      let deals: { id: string; label: string; stage: string | null; amount: unknown }[] = [];
      if (personId) {
        const dealType = await ctx.db.objectType.findFirst({
          where: { apiSlug: 'deal', deletedAt: null },
          select: { id: true },
        });
        if (dealType) {
          const attrs = await attributesFor(ctx.db, dealType.id);
          const stageAttr = attrs.find((a) => a.apiSlug === 'stage');
          const amountAttr = attrs.find((a) => a.apiSlug === 'amount');
          const rels = await ctx.db.recordRelation.findMany({
            where: {
              toRecordId: personId,
              deletedAt: null,
              fromRecord: { objectTypeId: dealType.id, deletedAt: null, mergeState: 'ACTIVE' },
            },
            include: { fromRecord: { select: { id: true, values: true } } },
            take: 20,
          });
          deals = rels.map((r) => {
            const v = r.fromRecord.values as Record<string, unknown>;
            return {
              id: r.fromRecord.id,
              label: recordLabel(attrs, v),
              stage:
                stageAttr && typeof v[stageAttr.id] === 'string'
                  ? (v[stageAttr.id] as string)
                  : null,
              amount: amountAttr ? v[amountAttr.id] : null,
            };
          });
        }
      }
      const timeline = await queryTimeline(ctx.db, {
        workspaceId: ctx.workspace.id,
        ...(personId ? { recordId: personId } : c.identityId ? { identityId: c.identityId } : {}),
        limit: 5,
      });
      const openThreads = await ctx.db.conversation.count({
        where: {
          deletedAt: null,
          status: 'OPEN',
          id: { not: c.id },
          ...(personId ? { personRecordId: personId } : { identityId: c.identityId ?? '' }),
        },
      });
      return {
        person: personId
          ? { id: personId, label: labels.get(personId)?.label ?? '(person)' }
          : null,
        identities: identities.map(identitySummary),
        deals,
        recent: timeline.items,
        openThreads,
      };
    }),

  reply: tenantJobProcedure
    .use(authorize('update', 'Conversation'))
    .input(
      id.extend({
        text: z.string().trim().min(1).max(8000),
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

  assign: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id.extend({ userId: z.string().uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadConversation(ctx.db, input.id);
      if (input.userId) {
        const member = await ctx.db.membership.findFirst({
          where: { userId: input.userId, deletedAt: null },
          select: { id: true },
        });
        if (!member)
          throw new NexusError('VALIDATION', {
            context: { reason: 'That person is not a member of this workspace.' },
          });
      }
      await ctx.db.conversation.update({ where: { id: c.id }, data: { assigneeId: input.userId } });
      await publishEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        topic: 'conversation.changed',
        payload: { ids: [c.id], field: 'assignee' },
      });
      await ctx.audit({
        action: 'conversation.assigned',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { from: c.assigneeId, to: input.userId },
      });
      return { id: c.id, assigneeId: input.userId };
    }),

  snooze: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id.extend({ until: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadConversation(ctx.db, input.id);
      if (input.until.getTime() <= Date.now())
        throw new NexusError('VALIDATION', {
          context: { reason: 'Snooze until a time in the future.' },
        });
      await ctx.db.conversation.update({
        where: { id: c.id },
        data: { status: 'SNOOZED', snoozedUntil: input.until },
      });
      await publishEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        topic: 'conversation.changed',
        payload: { ids: [c.id], field: 'status' },
      });
      await ctx.audit({
        action: 'conversation.snoozed',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { from: c.status, until: input.until },
      });
      return { id: c.id, status: 'SNOOZED' as const, snoozedUntil: input.until };
    }),

  setStatus: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id.extend({ status: z.enum(['OPEN', 'CLOSED', 'SPAM']) }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadConversation(ctx.db, input.id);
      await ctx.db.conversation.update({
        where: { id: c.id },
        data: {
          status: input.status,
          snoozedUntil: null,
          ...(input.status === 'OPEN' ? {} : { unreadCount: 0 }),
        },
      });
      await publishEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        topic: 'conversation.changed',
        payload: { ids: [c.id], field: 'status' },
      });
      await ctx.audit({
        action: 'conversation.status_changed',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { from: c.status, to: input.status },
      });
      return { id: c.id, status: input.status };
    }),

  setTags: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id.extend({ tags: z.array(tagSchema).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadConversation(ctx.db, input.id);
      const tags = [...new Set(input.tags.map((t) => t.toLowerCase()))];
      await ctx.db.conversation.update({ where: { id: c.id }, data: { tags } });
      await publishEvent(ctx.db, {
        workspaceId: ctx.workspace.id,
        topic: 'conversation.changed',
        payload: { ids: [c.id], field: 'tags' },
      });
      await ctx.audit({
        action: 'conversation.tagged',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { from: c.tags, to: tags },
      });
      return { id: c.id, tags };
    }),

  markRead: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const c = await loadConversation(ctx.db, input.id);
      if (c.unreadCount > 0) {
        await ctx.db.conversation.update({ where: { id: c.id }, data: { unreadCount: 0 } });
        await publishEvent(ctx.db, {
          workspaceId: ctx.workspace.id,
          topic: 'conversation.changed',
          payload: { ids: [c.id], field: 'unread' },
        });
      }
      await ctx.audit({
        action: 'conversation.read',
        targetType: 'Conversation',
        targetId: c.id,
        diff: { unread: c.unreadCount },
      });
      return { id: c.id };
    }),

  /** Bulk triage (§12.2.A): one action over many threads, one audit row per thread. */
  bulk: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(
      z.object({
        ids: z.array(z.string().uuid()).min(1).max(200),
        action: z.discriminatedUnion('type', [
          z.object({ type: z.literal('assign'), userId: z.string().uuid().nullable() }),
          z.object({ type: z.literal('status'), status: z.enum(['OPEN', 'CLOSED', 'SPAM']) }),
          z.object({ type: z.literal('snooze'), until: z.coerce.date() }),
          z.object({
            type: z.literal('tag'),
            add: z.array(tagSchema).max(20).default([]),
            remove: z.array(tagSchema).max(20).default([]),
          }),
          z.object({ type: z.literal('read') }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.conversation.findMany({
        where: { id: { in: input.ids }, deletedAt: null },
        select: { id: true, status: true, assigneeId: true, tags: true },
      });
      if (input.action.type === 'assign' && input.action.userId) {
        const member = await ctx.db.membership.findFirst({
          where: { userId: input.action.userId, deletedAt: null },
          select: { id: true },
        });
        if (!member)
          throw new NexusError('VALIDATION', {
            context: { reason: 'That person is not a member of this workspace.' },
          });
      }
      let changed = 0;
      for (const c of rows) {
        const a = input.action;
        let data: Prisma.ConversationUncheckedUpdateInput;
        let action: string;
        let diff: unknown;
        switch (a.type) {
          case 'assign':
            data = { assigneeId: a.userId };
            action = 'conversation.assigned';
            diff = { from: c.assigneeId, to: a.userId, bulk: true };
            break;
          case 'status':
            data = {
              status: a.status,
              snoozedUntil: null,
              ...(a.status === 'OPEN' ? {} : { unreadCount: 0 }),
            };
            action = 'conversation.status_changed';
            diff = { from: c.status, to: a.status, bulk: true };
            break;
          case 'snooze':
            data = { status: 'SNOOZED', snoozedUntil: a.until };
            action = 'conversation.snoozed';
            diff = { from: c.status, until: a.until, bulk: true };
            break;
          case 'tag': {
            const next = [
              ...new Set([
                ...c.tags.filter((t) => !a.remove.includes(t)),
                ...a.add.map((t) => t.toLowerCase()),
              ]),
            ];
            data = { tags: next };
            action = 'conversation.tagged';
            diff = { from: c.tags, to: next, bulk: true };
            break;
          }
          case 'read':
            data = { unreadCount: 0 };
            action = 'conversation.read';
            diff = { bulk: true };
            break;
        }
        await ctx.db.conversation.update({ where: { id: c.id }, data });
        await ctx.audit({ action, targetType: 'Conversation', targetId: c.id, diff });
        changed += 1;
      }
      if (rows.length)
        await publishEvent(ctx.db, {
          workspaceId: ctx.workspace.id,
          topic: 'conversation.changed',
          payload: { ids: rows.map((r) => r.id), bulk: input.action.type },
        });
      if (changed === 0)
        await ctx.audit({
          action: 'conversation.bulk_noop',
          targetType: 'Conversation',
          targetId: input.ids[0]!,
          diff: { ids: input.ids },
        });
      return { changed };
    }),
});
