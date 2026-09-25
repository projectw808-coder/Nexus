/**
 * Stage 5 for conversations (§4.1 "materialize"): canonical persons become `Identity` rows,
 * conversations become `Conversation` rows and messages become `Message` rows, all upserted
 * on their platform ids so replays and webhook redeliveries are no-ops. Identity → Person
 * resolution (§10) is the identity sink's job, which runs after this one; a conversation whose
 * identity is already resolved gets `personRecordId` at once.
 *
 * Messages may arrive before their conversation (a comment on a post we never fetched); the
 * sink then creates the thread from the message. A conversation's `lastMessageAt`,
 * `unreadCount` and the messaging window follow the newest inbound message.
 */
import type {
  CanonicalConversation,
  CanonicalMessage,
  CanonicalPerson,
  Platform,
} from '@nexus/connector-sdk';
import {
  publishEvent,
  slaDueFor,
  slaMinutesFor,
  systemActorFor,
  upsertIdentity as upsertIdentityRow,
  type ConversationKind,
  type Prisma,
  type TenantDb,
  type TenantRuntime,
} from '@nexus/db';
import type { CanonicalSink, NormalizedBatch } from '../sink.ts';

const KIND_OF: Record<CanonicalConversation['conversationType'], ConversationKind> = {
  dm: 'DM',
  comment_thread: 'COMMENT_THREAD',
  mention_thread: 'MENTION',
  review_thread: 'REVIEW',
  email_thread: 'EMAIL_THREAD',
  other: 'COMMENT_THREAD',
};

function kindFromMessage(m: CanonicalMessage): ConversationKind {
  switch (m.messageType) {
    case 'dm':
      return 'DM';
    case 'mention':
      return 'MENTION';
    case 'email':
      return 'EMAIL_THREAD';
    case 'review_reply':
      return 'REVIEW';
    default:
      return 'COMMENT_THREAD';
  }
}

export type ConversationSinkStats = { identities: number; conversations: number; messages: number };

export function createConversationSink(
  runtime: TenantRuntime,
  opts: {
    windowHoursFor?: (platform: Platform) => number | null;
    onChange?: (change: {
      workspaceId: string;
      connectionId: string;
      conversationIds: string[];
    }) => void;
  } = {},
): CanonicalSink & { stats: ConversationSinkStats } {
  const stats: ConversationSinkStats = { identities: 0, conversations: 0, messages: 0 };

  const personCache = new Map<string, string | null>();
  async function upsertIdentity(
    db: TenantDb,
    workspaceId: string,
    platform: Platform,
    p:
      CanonicalPerson | { externalId: string; handle?: string | null; displayName?: string | null },
    seenAt: Date,
    connectionId: string,
  ): Promise<string> {
    const full = 'kind' in p ? p : null;
    const r = await upsertIdentityRow(db, {
      workspaceId,
      platform,
      externalId: p.externalId,
      seenAt,
      handle: p.handle ?? null,
      displayName: p.displayName ?? null,
      avatarUrl: full?.avatarUrl ?? null,
      profileUrl: full?.profileUrl ?? null,
      email: full?.email ?? null,
      phone: full?.phone ?? null,
      ...(full ? { raw: full.raw } : {}),
      ...(full
        ? {
            canonical: {
              bio: full.bio ?? null,
              locale: full.locale ?? null,
              timezone: full.timezone ?? null,
              companyExternalId: full.companyExternalId ?? null,
            },
          }
        : {}),
      connectionId,
    });
    if (r.created) stats.identities += 1;
    personCache.set(r.id, r.personRecordId);
    return r.id;
  }

  return {
    stats,
    async materialize(batch: NormalizedBatch) {
      const persons = new Map<string, CanonicalPerson>();
      const conversations = new Map<string, CanonicalConversation>();
      const messages: CanonicalMessage[] = [];
      for (const item of batch.items) {
        for (const e of item.entities) {
          if (e.kind === 'person') persons.set(e.externalId, e);
          else if (e.kind === 'conversation') conversations.set(e.externalId, e);
          else if (e.kind === 'message') messages.push(e);
        }
      }
      if (persons.size === 0 && conversations.size === 0 && messages.length === 0) return;
      const actor = systemActorFor(batch.workspaceId, batch.connectionId);
      const touched = new Set<string>();

      await runtime.withTenant(actor, async (db) => {
        const slaMinutes = await slaMinutesFor(db, batch.connectionId);
        const identityIds = new Map<string, string>();
        for (const p of persons.values())
          identityIds.set(
            p.externalId,
            await upsertIdentity(
              db,
              batch.workspaceId,
              batch.platform,
              p,
              p.occurredAt,
              batch.connectionId,
            ),
          );

        const conversationIds = new Map<string, string>();
        const ensureConversation = async (
          externalId: string,
          seed: {
            kind: ConversationKind;
            customerExternalId: string | null;
            subject: string | null;
            at: Date;
            parentExternalId: string | null;
            sourceUrl: string | null;
          },
        ): Promise<string> => {
          const cached = conversationIds.get(externalId);
          if (cached) return cached;
          const existing = await db.conversation.findFirst({
            where: { connectionId: batch.connectionId, externalId },
            select: { id: true },
          });
          if (existing) {
            conversationIds.set(externalId, existing.id);
            return existing.id;
          }
          let identityId: string | null = null;
          if (seed.customerExternalId)
            identityId =
              identityIds.get(seed.customerExternalId) ??
              (await upsertIdentity(
                db,
                batch.workspaceId,
                batch.platform,
                { externalId: seed.customerExternalId },
                seed.at,
                batch.connectionId,
              ));
          const created = await db.conversation.create({
            data: {
              workspaceId: batch.workspaceId,
              connectionId: batch.connectionId,
              platform: batch.platform,
              kind: seed.kind,
              externalId,
              subject: seed.subject,
              identityId,
              personRecordId: identityId ? (personCache.get(identityId) ?? null) : null,
              lastMessageAt: seed.at,
              parentExternalId: seed.parentExternalId,
            },
            select: { id: true },
          });
          stats.conversations += 1;
          conversationIds.set(externalId, created.id);
          return created.id;
        };

        for (const c of conversations.values()) {
          const customer =
            c.participants.find((p) => p.role === 'customer') ??
            c.participants.find((p) => p.role !== 'owner');
          const id = await ensureConversation(c.externalId, {
            kind: KIND_OF[c.conversationType],
            customerExternalId: customer?.externalId ?? null,
            subject: c.subject,
            at: c.lastMessageAt ?? c.occurredAt,
            parentExternalId: c.rootExternalId,
            sourceUrl: c.sourceUrl,
          });
          const row = await db.conversation.findUniqueOrThrow({
            where: { id },
            select: { lastMessageAt: true, identityId: true, subject: true },
          });
          const data: Prisma.ConversationUpdateInput = {};
          if (c.lastMessageAt && c.lastMessageAt > row.lastMessageAt)
            data.lastMessageAt = c.lastMessageAt;
          if (!row.identityId && customer) {
            const idn =
              identityIds.get(customer.externalId) ??
              (await upsertIdentity(
                db,
                batch.workspaceId,
                batch.platform,
                {
                  externalId: customer.externalId,
                  handle: customer.handle,
                  displayName: customer.displayName,
                },
                c.occurredAt,
                batch.connectionId,
              ));
            data.identity = { connect: { id: idn } };
          }
          if (c.subject && c.subject !== row.subject) data.subject = c.subject;
          if (c.status === 'closed' || c.status === 'archived') data.status = 'CLOSED';
          if (Object.keys(data).length) await db.conversation.update({ where: { id }, data });
          touched.add(id);
        }

        for (const m of messages) {
          const customer =
            m.direction === 'inbound' ? m.authorExternalId : (m.recipientExternalIds?.[0] ?? null);
          const conversationId = await ensureConversation(m.conversationExternalId, {
            kind: kindFromMessage(m),
            customerExternalId: customer,
            subject: null,
            at: m.sentAt,
            parentExternalId: m.rootExternalId,
            sourceUrl: m.sourceUrl,
          });
          const authorIdentityId =
            m.direction === 'inbound'
              ? (identityIds.get(m.authorExternalId) ??
                (await upsertIdentity(
                  db,
                  batch.workspaceId,
                  batch.platform,
                  { externalId: m.authorExternalId },
                  m.sentAt,
                  batch.connectionId,
                )))
              : null;
          const existing = await db.message.findFirst({
            where: { conversationId, externalId: m.externalId },
            select: { id: true },
          });
          const common = {
            body: m.body,
            bodyHtml: m.bodyHtml ?? null,
            attachments: m.attachments as Prisma.InputJsonValue,
            sentAt: m.sentAt,
            replyWindowExpiresAt: m.replyWindowExpiresAt ?? null,
            sourceUrl: m.sourceUrl ?? null,
            raw: m.raw as Prisma.InputJsonValue,
          };
          if (existing) {
            await db.message.update({
              where: { id: existing.id },
              data: { ...common, ...(m.isDeleted ? { deletedAt: new Date() } : {}) },
            });
          } else {
            await db.message.create({
              data: {
                workspaceId: batch.workspaceId,
                conversationId,
                externalId: m.externalId,
                direction: m.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
                authorIdentityId,
                deliveryState: m.direction === 'inbound' ? 'DELIVERED' : 'SENT',
                ...(m.outboundActionId ? { outboundActionId: m.outboundActionId } : {}),
                ...common,
              },
            });
            stats.messages += 1;
            const conv = await db.conversation.findUniqueOrThrow({
              where: { id: conversationId },
              select: {
                lastMessageAt: true,
                identityId: true,
                status: true,
                slaDueAt: true,
                firstResponseAt: true,
              },
            });
            await db.conversation.update({
              where: { id: conversationId },
              data: {
                ...(m.sentAt > conv.lastMessageAt ? { lastMessageAt: m.sentAt } : {}),
                ...(m.direction === 'inbound'
                  ? {
                      unreadCount: { increment: 1 },
                      // A customer writing again reopens a closed or snoozed thread…
                      ...(conv.status === 'CLOSED' || conv.status === 'SNOOZED'
                        ? { status: 'OPEN' as const, snoozedUntil: null }
                        : {}),
                      // …and starts the SLA clock if none is running.
                      ...(conv.slaDueAt === null && slaMinutes
                        ? { slaDueAt: slaDueFor(m.sentAt, slaMinutes) }
                        : {}),
                    }
                  : {
                      // Our side answered: the clock stops, the first response is recorded once.
                      slaDueAt: null,
                      ...(conv.firstResponseAt ? {} : { firstResponseAt: m.sentAt }),
                    }),
                ...(!conv.identityId && authorIdentityId
                  ? { identity: { connect: { id: authorIdentityId } } }
                  : {}),
              },
            });
          }
          touched.add(conversationId);
        }
        if (touched.size)
          await publishEvent(db, {
            workspaceId: batch.workspaceId,
            topic: 'conversation.changed',
            payload: { ids: [...touched], connectionId: batch.connectionId },
          });
      });
      if (touched.size)
        opts.onChange?.({
          workspaceId: batch.workspaceId,
          connectionId: batch.connectionId,
          conversationIds: [...touched],
        });
    },
  };
}

/** Run several sinks in sequence (counting + conversations, later identity/timeline/automation). */
export function composeSinks(...sinks: CanonicalSink[]): CanonicalSink {
  return {
    async materialize(batch) {
      for (const s of sinks) await s.materialize(batch);
    },
  };
}
