/**
 * `GET /v1/conversations/{id}/messages` · `POST /v1/conversations/{id}/messages` (§11.2).
 *
 * The POST goes through `requestReply` — the identical preflight → `OutboundAction` flow the
 * in-app composer uses (§9.3), just from a different auth context. `OutboundAction`'s
 * `requestedByUserId` is NOT NULL and an API-key actor has no user of its own, so the send is
 * attributed to the connection's owner, exactly as Phase 10 resolves it for a workflow actor
 * (`apps/worker/src/automation.ts`). A platform policy block comes back as a 202 with
 * `status: "blocked"`, not an error — the request succeeded; the platform said no.
 */
import { createMessageSchema, pageQuerySchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { requestReply } from '@nexus/sync';
import { randomUUID } from 'node:crypto';
import { restRoute } from '../../../_lib/handler';
import { cappedLimit, decodeDateCursor, paginate, restMessage } from '../../../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute<{ id: string }>('READ', async (ctx, params) => {
  const q = ctx.query(pageQuerySchema);
  const take = cappedLimit(q.limit);
  const after = decodeDateCursor(q.cursor);
  return ctx.withTenant(async (db) => {
    const conv = await db.conversation.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true },
    });
    if (!conv) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
    const rows = await db.message.findMany({
      where: {
        conversationId: conv.id,
        deletedAt: null,
        ...(after
          ? { OR: [{ sentAt: { gt: after.at } }, { sentAt: after.at, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
    });
    const page = paginate(rows, take, (r) => r.sentAt);
    return { body: { items: page.items.map(restMessage), nextCursor: page.nextCursor } };
  });
});

export const POST = restRoute<{ id: string }>('WRITE', async (ctx, params) => {
  const input = ctx.parse(createMessageSchema);
  // The nonce collapses a retried send onto one OutboundAction. A caller that already sent an
  // Idempotency-Key has expressed the same intent, so reuse it rather than minting a second one.
  const requestNonce =
    input.requestNonce ?? ctx.req.headers.get('idempotency-key')?.trim() ?? randomUUID();

  const conv = await ctx.withTenant(async (db) => {
    const row = await db.conversation.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, connection: { select: { ownerUserId: true } } },
    });
    if (!row) throw new NexusError('NOT_FOUND', { message: 'Conversation not found.' });
    return row;
  });

  const outcome = await requestReply(ctx.deps.sync, {
    actor: ctx.actor,
    conversationId: conv.id,
    text: input.text,
    requestNonce: requestNonce.slice(0, 64).padEnd(8, '0'),
    ...(conv.connection.ownerUserId ? { requestedByUserId: conv.connection.ownerUserId } : {}),
  });

  await ctx.withTenant((db) =>
    ctx.audit(db, {
      action: `conversation.reply_${outcome.status}`,
      targetType: 'Conversation',
      targetId: conv.id,
      diff: {
        outboundActionId: outcome.outboundActionId,
        via: 'rest_v1',
        ...(outcome.status === 'blocked' ? { code: outcome.code, reason: outcome.reason } : {}),
      },
    }),
  );

  return {
    status: 202,
    body: {
      status: outcome.status,
      outboundActionId: outcome.outboundActionId,
      duplicate: outcome.duplicate,
      ...(outcome.status === 'queued' ? { warnings: outcome.warnings } : {}),
      ...(outcome.status === 'blocked'
        ? { code: outcome.code, reason: outcome.reason, remediation: outcome.remediation }
        : {}),
    },
  };
});
