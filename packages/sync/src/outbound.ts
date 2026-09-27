/**
 * Outbound writes (spec §9.3): every platform write goes through an `OutboundAction` with the
 * §6.4 idempotency key — content PLUS a per-intent nonce minted by the client — and the flow
 * `preflight()` → enqueue → `execute()` → persist `externalId` → the outbound `Message` row.
 * A send that fails preflight is recorded BLOCKED with the reason and never reaches the queue.
 */
import { createHash } from 'node:crypto';
import { QUEUES } from '@nexus/config';
import type { OutboundActionInput, OutboundActionKind } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import {
  recordIntegrationError,
  systemActorFor,
  writeAudit,
  type Actor,
  type Prisma,
  publishEvent,
  emitTimelineEvent,
} from '@nexus/db';
import { bindConnection } from './context.ts';
import { nowOf, type SyncDeps } from './deps.ts';
import { applyFailure, asNexusError } from './failures.ts';

export const OUTBOUND_JOB = 'outbound.execute';

export function idempotencyKeyFor(parts: {
  connectionId: string;
  kind: string;
  conversationId: string | null;
  content: unknown;
  requestNonce: string;
}): string {
  const contentHash = createHash('sha256').update(JSON.stringify(parts.content)).digest('hex');
  return createHash('sha256')
    .update(
      [
        parts.connectionId,
        parts.kind,
        parts.conversationId ?? '',
        contentHash,
        parts.requestNonce,
      ].join(' '),
    )
    .digest('hex');
}

export type ReplyRequest = {
  actor: Actor;
  conversationId: string;
  text: string;
  /** Minted client-side per user intent (one click of Send); replayed on retry. */
  requestNonce: string;
  /** Approval gate (Phase 10): when set, the action waits in PENDING_APPROVAL. */
  requiresApproval?: boolean;
  /**
   * Who `OutboundAction.requestedByUserId` (NOT NULL) attributes this send to, when `actor` has
   * no `userId` of its own — a workflow's `send_reply` action (Phase 10, §14) acts as a
   * `WORKFLOW` actor, never a `USER`, so it must supply this explicitly (the caller resolves it,
   * typically to the connection's owner). Ignored when `actor.userId` is set.
   */
  requestedByUserId?: string;
};

export type ReplyOutcome =
  | {
      status: 'queued';
      outboundActionId: string;
      jobId: string;
      warnings: string[];
      duplicate: false;
    }
  | { status: 'duplicate'; outboundActionId: string; duplicate: true }
  | {
      status: 'blocked';
      outboundActionId: string;
      code: string;
      reason: string;
      remediation: string;
      duplicate: false;
    };

/** Request a reply in a conversation: preflight now, execute on the outbound queue. */
export async function requestReply(deps: SyncDeps, input: ReplyRequest): Promise<ReplyOutcome> {
  const { actor } = input;
  const requestedByUserId = actor.userId ?? input.requestedByUserId;
  if (!requestedByUserId)
    throw new NexusError('FORBIDDEN', { message: 'a user must send the reply' });
  const conv = await deps.runtime.withTenant(actor, (db) =>
    db.conversation.findFirst({
      where: { id: input.conversationId, deletedAt: null },
      include: {
        connection: { select: { id: true, platform: true, status: true } },
        messages: {
          where: { deletedAt: null },
          orderBy: { sentAt: 'desc' },
          take: 50,
          select: { externalId: true, direction: true, sentAt: true },
        },
      },
    }),
  );
  if (!conv) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
  const lastInbound = conv.messages.find((m) => m.direction === 'INBOUND') ?? null;
  const kind: OutboundActionKind = conv.kind === 'DM' ? 'reply_dm' : 'reply_comment';
  const payload = { text: input.text };
  const idempotencyKey = idempotencyKeyFor({
    connectionId: conv.connectionId,
    kind,
    conversationId: conv.id,
    content: payload,
    requestNonce: input.requestNonce,
  });

  // A retried click collapses onto the existing action.
  const existing = await deps.runtime.withTenant(actor, (db) =>
    db.outboundAction.findFirst({
      where: { connectionId: conv.connectionId, idempotencyKey },
      select: { id: true },
    }),
  );
  if (existing) return { status: 'duplicate', outboundActionId: existing.id, duplicate: true };

  const action: OutboundActionInput = {
    id: 'pending',
    kind,
    conversationExternalId: conv.externalId,
    targetExternalId:
      kind === 'reply_comment'
        ? (lastInbound?.externalId ?? conv.parentExternalId ?? undefined)
        : undefined,
    payload,
    idempotencyKey,
    requestNonce: input.requestNonce,
    requestedByUserId,
    context: { lastInboundAt: lastInbound?.sentAt ?? null, conversationKind: conv.kind },
  };

  const bound = await bindConnection(deps, {
    workspaceId: actor.workspaceId,
    connectionId: conv.connectionId,
    lane: 'interactive',
  });
  const preflight =
    conv.connection.status === 'CONNECTED' || conv.connection.status === 'DEGRADED'
      ? await bound.connector.preflight(bound.ctx, action)
      : ({
          ok: false,
          code: 'AUTH_EXPIRED',
          reason: `${bound.connection.label} is ${conv.connection.status.toLowerCase().replace('_', ' ')}`,
          remediation: 'Reconnect or resume the connection before replying.',
        } as const);

  const row = await deps.runtime.withTenant(actor, async (db) => {
    const created = await db.outboundAction.create({
      data: {
        workspaceId: actor.workspaceId,
        connectionId: conv.connectionId,
        conversationId: conv.id,
        kind,
        payload: payload as Prisma.InputJsonValue,
        idempotencyKey,
        status: preflight.ok ? (input.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED') : 'BLOCKED',
        requestedByUserId,
        ...(preflight.ok ? {} : { errorCode: preflight.code, errorMessage: preflight.reason }),
      },
      select: { id: true },
    });
    await writeAudit(db, actor, {
      action: preflight.ok ? 'outbound.requested' : 'outbound.blocked',
      targetType: 'OutboundAction',
      targetId: created.id,
      diff: {
        kind,
        conversationId: conv.id,
        platform: conv.platform,
        ...(preflight.ok
          ? { warnings: preflight.warnings }
          : { code: preflight.code, reason: preflight.reason }),
      },
    });
    return created;
  });

  if (!preflight.ok)
    return {
      status: 'blocked',
      outboundActionId: row.id,
      code: preflight.code,
      reason: preflight.reason,
      remediation: preflight.remediation,
      duplicate: false,
    };
  if (input.requiresApproval)
    return {
      status: 'queued',
      outboundActionId: row.id,
      jobId: 'awaiting-approval',
      warnings: preflight.warnings,
      duplicate: false,
    };
  const job = await deps.bus.enqueue({
    queue: QUEUES.outbound,
    name: OUTBOUND_JOB,
    data: {
      workspaceId: actor.workspaceId,
      connectionId: conv.connectionId,
      outboundActionId: row.id,
    },
    opts: { jobId: `outbound-${row.id}`, lane: 'interactive' },
  });
  return {
    status: 'queued',
    outboundActionId: row.id,
    jobId: job.jobId,
    warnings: preflight.warnings,
    duplicate: false,
  };
}

export type OutboundJob = { workspaceId: string; connectionId: string; outboundActionId: string };

/** The queue handler: execute on the platform, persist the id, write the outbound Message row. */
export async function executeOutbound(
  deps: SyncDeps,
  job: OutboundJob,
): Promise<{ status: 'sent' | 'skipped' | 'failed'; externalId?: string; messageId?: string }> {
  const actor = systemActorFor(job.workspaceId, job.connectionId);
  const row = await deps.runtime.withTenant(actor, (db) =>
    db.outboundAction.findFirst({
      where: { id: job.outboundActionId },
      include: {
        conversation: {
          select: {
            id: true,
            externalId: true,
            kind: true,
            parentExternalId: true,
            messages: {
              where: { direction: 'INBOUND', deletedAt: null },
              orderBy: { sentAt: 'desc' },
              take: 1,
              select: { externalId: true, sentAt: true },
            },
          },
        },
      },
    }),
  );
  if (!row) throw new NexusError('NOT_FOUND', { message: 'outbound action not found' });
  if (row.status === 'SENT') return { status: 'skipped', externalId: row.externalId ?? undefined };
  if (row.status !== 'QUEUED' && row.status !== 'SENDING' && row.status !== 'FAILED')
    return { status: 'skipped' };

  const bound = await bindConnection(deps, {
    workspaceId: job.workspaceId,
    connectionId: job.connectionId,
    lane: 'interactive',
  });
  await deps.runtime.withTenant(actor, (db) =>
    db.outboundAction.update({
      where: { id: row.id },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    }),
  );
  const lastInbound = row.conversation?.messages[0] ?? null;
  const input: OutboundActionInput = {
    id: row.id,
    kind: row.kind as OutboundActionKind,
    conversationExternalId: row.conversation?.externalId,
    targetExternalId:
      row.kind === 'reply_comment'
        ? (lastInbound?.externalId ?? row.conversation?.parentExternalId ?? undefined)
        : undefined,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    requestNonce: row.idempotencyKey.slice(0, 16),
    requestedByUserId: row.requestedByUserId,
    context: {
      lastInboundAt: lastInbound?.sentAt ?? null,
      conversationKind: row.conversation?.kind,
    },
  };
  try {
    const result = await bound.connector.execute(bound.ctx, input);
    const text =
      typeof (row.payload as { text?: unknown }).text === 'string'
        ? (row.payload as { text: string }).text
        : '';
    const messageId = await deps.runtime.withTenant(actor, async (db) => {
      await db.outboundAction.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          externalId: result.externalId,
          sentAt: result.sentAt,
          errorCode: null,
          errorMessage: null,
        },
      });
      let messageId: string | undefined;
      if (row.conversationId) {
        const existing = await db.message.findFirst({
          where: { conversationId: row.conversationId, externalId: result.externalId },
          select: { id: true },
        });
        const msg = existing
          ? await db.message.update({
              where: { id: existing.id },
              data: {
                outboundActionId: row.id,
                deliveryState: 'SENT',
                authorUserId: row.requestedByUserId,
              },
              select: { id: true },
            })
          : await db.message.create({
              data: {
                workspaceId: job.workspaceId,
                conversationId: row.conversationId,
                externalId: result.externalId,
                direction: 'OUTBOUND',
                authorUserId: row.requestedByUserId,
                outboundActionId: row.id,
                body: text,
                attachments: [],
                sentAt: result.sentAt,
                deliveryState: 'SENT',
                raw: result.raw as Prisma.InputJsonValue,
              },
              select: { id: true },
            });
        messageId = msg.id;
        const conv = await db.conversation.findFirst({
          where: { id: row.conversationId },
          select: {
            firstResponseAt: true,
            lastMessageAt: true,
            externalId: true,
            kind: true,
            identityId: true,
            personRecordId: true,
            platform: true,
          },
        });
        await db.conversation.update({
          where: { id: row.conversationId },
          data: {
            ...(conv && conv.lastMessageAt > result.sentAt ? {} : { lastMessageAt: result.sentAt }),
            slaDueAt: null,
            ...(conv?.firstResponseAt ? {} : { firstResponseAt: result.sentAt }),
          },
        });
        // The reply is on the person's timeline at once; a platform echo later dedupes on the same key.
        if (conv)
          await emitTimelineEvent(db, {
            workspaceId: job.workspaceId,
            dedupeKey: `msg:${job.connectionId}:${conv.externalId}:${result.externalId}`,
            type:
              conv.kind === 'DM'
                ? 'MESSAGE'
                : conv.kind === 'MENTION'
                  ? 'MENTION'
                  : conv.kind === 'EMAIL_THREAD'
                    ? 'EMAIL'
                    : 'COMMENT',
            occurredAt: result.sentAt,
            identityId: conv.identityId,
            recordId: conv.personRecordId,
            platform: conv.platform,
            connectionId: job.connectionId,
            actorUserId: row.requestedByUserId,
            summary: `You replied: “${text.replace(/\s+/g, ' ').trim().slice(0, 140)}”`,
            payload: {
              kind: 'message',
              direction: 'outbound',
              conversationExternalId: conv.externalId,
              outboundActionId: row.id,
              body: text.slice(0, 500),
            },
          });
        await publishEvent(db, {
          workspaceId: job.workspaceId,
          topic: 'conversation.changed',
          payload: { ids: [row.conversationId], outboundActionId: row.id, status: 'SENT' },
        });
      }
      await writeAudit(
        db,
        { ...actor, userId: row.requestedByUserId, actorType: 'USER' },
        {
          action: 'outbound.sent',
          targetType: 'OutboundAction',
          targetId: row.id,
          diff: {
            kind: row.kind,
            platform: bound.connection.platform,
            connectionId: job.connectionId,
            conversationId: row.conversationId,
            externalId: result.externalId,
            sentAt: result.sentAt,
          },
        },
      );
      return messageId;
    });
    return { status: 'sent', externalId: result.externalId, messageId };
  } catch (e) {
    const err = asNexusError(e);
    const outcome = await applyFailure(deps, { connection: bound.connection, error: err });
    await deps.runtime.withTenant(actor, async (db) => {
      await db.outboundAction.update({
        where: { id: row.id },
        data: { status: 'FAILED', errorCode: err.code, errorMessage: err.userMessage },
      });
      if (row.conversationId)
        await publishEvent(db, {
          workspaceId: job.workspaceId,
          topic: 'conversation.changed',
          payload: { ids: [row.conversationId], outboundActionId: row.id, status: 'FAILED' },
        });
      await recordIntegrationError(db, {
        workspaceId: job.workspaceId,
        connectionId: job.connectionId,
        outboundActionId: row.id,
        platform: bound.connection.platform,
        error: err,
      });
    });
    if (outcome.retry) throw err;
    return { status: 'failed' };
  }
}

export const nowForTests = nowOf;
