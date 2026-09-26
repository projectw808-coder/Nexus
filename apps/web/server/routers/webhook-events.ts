/**
 * The Webhooks tab's delivery log (§12.2.C): every inbound payload for a connection, verified or
 * not, with one-click replay for a verified-but-unprocessed delivery. Replaying re-enqueues the
 * same ingest job the original delivery used, which is idempotent by construction (§9.1) — a
 * duplicate delivery of the same object is a no-op through the raw store.
 */
import { QUEUES } from '@nexus/config';
import { getWebhookEvent, listWebhookEvents } from '@nexus/db';
import { NexusError } from '@nexus/core';
import { JOB_NAMES } from '@nexus/sync';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

export const webhookEventRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(
      z.object({
        connectionId: z.string().uuid(),
        verified: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const connection = await ctx.db.connection.findFirst({
        where: { id: input.connectionId, deletedAt: null },
        select: { id: true },
      });
      if (!connection) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
      return listWebhookEvents(ctx.db, input);
    }),

  replay: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const event = await getWebhookEvent(ctx.db, input.id);
      if (!event) throw new NexusError('NOT_FOUND', { message: 'Webhook delivery not found.' });
      if (!event.verified)
        throw new NexusError('VALIDATION', {
          context: { reason: 'A rejected delivery has nothing to replay — reconnect first.' },
        });
      if (!event.connectionId)
        throw new NexusError('VALIDATION', {
          context: { reason: 'This delivery was never routed to a connection.' },
        });
      const job = await ctx.sync.bus.enqueue({
        queue: QUEUES.ingestRaw,
        name: JOB_NAMES.ingestWebhook,
        data: {
          workspaceId: ctx.workspace.id,
          connectionId: event.connectionId,
          eventId: event.id,
        },
        opts: { jobId: `webhook-replay:${event.id}:${Date.now()}`, lane: 'webhook' },
      });
      await ctx.audit({
        action: 'webhook_event.replayed',
        targetType: 'WebhookEvent',
        targetId: event.id,
        diff: { jobId: job.jobId },
      });
      return { jobId: job.jobId };
    }),
});
