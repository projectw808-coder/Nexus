/**
 * Customer-facing outbound webhooks (§11.2, ADR-022 decision 4): subscription CRUD, the delivery
 * log, and replay. Owner/admin only — a subscription hands a third party a copy of this
 * workspace's events, and creating one reveals a signing secret.
 *
 * The plaintext signing secret is returned by `create` and `rotateSecret` and never again: it only
 * exists in the TokenVault afterwards (`@nexus/db`'s `createSubscription`). The UI shows it once
 * with a "you will not see this again" notice, the same discipline as any other
 * secret-reveal-once surface in this product.
 */
import { NexusError } from '@nexus/core';
import {
  OUTBOUND_EVENT_DESCRIPTION,
  OUTBOUND_EVENT_TYPES,
  OutboundDeliveryStatus,
  SIGNATURE_HEADER,
  createSubscription,
  deleteSubscription,
  deliveryCounts,
  getDelivery,
  getSubscription,
  listDeliveries,
  listSubscriptions,
  replayDelivery,
  rotateSubscriptionSecret,
  updateSubscription,
} from '@nexus/db';
import { enqueueOutboundWebhookDelivery } from '@nexus/sync';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const eventName = z.enum(OUTBOUND_EVENT_TYPES);
const deliveryStatus = z.enum(
  Object.values(OutboundDeliveryStatus) as [OutboundDeliveryStatus, ...OutboundDeliveryStatus[]],
);

export const outboundWebhookRouter = router({
  /** The event vocabulary and the signature header name, so the UI and docs cannot drift. */
  catalog: tenantProcedure.use(authorize('read', 'OutboundWebhook')).query(() => ({
    signatureHeader: SIGNATURE_HEADER,
    events: OUTBOUND_EVENT_TYPES.map((name) => ({
      name,
      description: OUTBOUND_EVENT_DESCRIPTION[name],
    })),
  })),

  list: tenantProcedure.use(authorize('read', 'OutboundWebhook')).query(async ({ ctx }) => {
    const subscriptions = await listSubscriptions(ctx.db);
    return Promise.all(
      subscriptions.map(async (s) => ({ ...s, counts: await deliveryCounts(ctx.db, s.id) })),
    );
  }),

  create: tenantProcedure
    .use(authorize('create', 'OutboundWebhook'))
    .input(
      z.object({
        url: z.string().min(1).max(2048),
        events: z.array(eventName).min(1),
        description: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { subscription, secretPlaintext } = await createSubscription(
        ctx.db,
        ctx.actor,
        ctx.sync.vault,
        input,
      );
      await ctx.audit({
        action: 'outbound_webhook.created',
        targetType: 'OutboundWebhookSubscription',
        targetId: subscription.id,
        diff: { url: subscription.url, events: subscription.events },
      });
      return { subscription, secretPlaintext };
    }),

  update: tenantProcedure
    .use(authorize('update', 'OutboundWebhook'))
    .input(
      z.object({
        id: z.string().uuid(),
        url: z.string().min(1).max(2048).optional(),
        events: z.array(eventName).min(1).optional(),
        enabled: z.boolean().optional(),
        description: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const before = await getSubscription(ctx.db, id);
      const after = await updateSubscription(ctx.db, id, patch);
      await ctx.audit({
        action: 'outbound_webhook.updated',
        targetType: 'OutboundWebhookSubscription',
        targetId: after.id,
        diff: {
          ...(patch.url !== undefined ? { url: { from: before.url, to: after.url } } : {}),
          ...(patch.events !== undefined
            ? { events: { from: before.events, to: after.events } }
            : {}),
          ...(patch.enabled !== undefined
            ? { enabled: { from: before.enabled, to: after.enabled } }
            : {}),
          ...(patch.description !== undefined
            ? { description: { from: before.description, to: after.description } }
            : {}),
        },
      });
      return after;
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'OutboundWebhook'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const before = await getSubscription(ctx.db, input.id);
      const row = await deleteSubscription(ctx.db, ctx.sync.vault, input.id);
      await ctx.audit({
        action: 'outbound_webhook.deleted',
        targetType: 'OutboundWebhookSubscription',
        targetId: row.id,
        diff: { url: before.url },
      });
      return row;
    }),

  /** Mint a new signing secret. Returned once; the old one stops working immediately. */
  rotateSecret: tenantProcedure
    .use(authorize('update', 'OutboundWebhook'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await rotateSubscriptionSecret(ctx.db, ctx.sync.vault, input.id);
      await ctx.audit({
        action: 'outbound_webhook.secret_rotated',
        targetType: 'OutboundWebhookSubscription',
        targetId: result.id,
      });
      return result;
    }),

  /** The delivery log for one subscription, newest first. */
  deliveries: tenantProcedure
    .use(authorize('read', 'OutboundWebhook'))
    .input(
      z.object({
        subscriptionId: z.string().uuid(),
        status: deliveryStatus.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      await getSubscription(ctx.db, input.subscriptionId); // 404s across tenants, never leaks
      return listDeliveries(ctx.db, input);
    }),

  /** One delivery with the exact payload that was (or will be) sent. */
  delivery: tenantProcedure
    .use(authorize('read', 'OutboundWebhook'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await getDelivery(ctx.db, input.id);
      if (!row) throw new NexusError('NOT_FOUND', { message: 'Webhook delivery not found.' });
      return row;
    }),

  /**
   * Replay a delivered or dead-lettered delivery: the row resets to PENDING in place — the same
   * shape as the inbound webhook replay in Phase 9 — and is re-enqueued for a fresh attempt chain.
   */
  replay: tenantProcedure
    .use(authorize('update', 'OutboundWebhook'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const pending = await replayDelivery(ctx.db, ctx.actor, input.id);
      await ctx.audit({
        action: 'outbound_webhook.replayed',
        targetType: 'OutboundWebhookDelivery',
        targetId: pending.deliveryId,
        diff: { subscriptionId: pending.subscriptionId, eventType: pending.eventType },
      });
      await enqueueOutboundWebhookDelivery(
        ctx.sync.bus,
        {
          workspaceId: pending.workspaceId,
          deliveryId: pending.deliveryId,
          subscriptionId: pending.subscriptionId,
          eventType: pending.eventType,
        },
        { attempts: 0, replayNonce: String(Date.now()) },
      );
      return { id: pending.deliveryId };
    }),
});
