/**
 * The customer-facing event vocabulary and the fan-out step (§11.2, ADR-022 decision 4).
 *
 * Outbound webhooks are a *second consumer* of the same "an event happened" call sites Phase 10's
 * automation engine already established — `packages/sync/src/react.ts`'s stage-6 loop and the
 * record/list mutations in `apps/web`. This module does the half of that which only needs the
 * database: match the event against every enabled subscription, create one `PENDING`
 * `OutboundWebhookDelivery` per match, and hand the caller the list to enqueue. The mapping from
 * an internal `AutomationEvent.type` to a public event name lives in `@nexus/sync` (the layer
 * that knows that type); this package only knows the public names.
 *
 * The public names are NOT identical to the internal `TriggerType` list: the three
 * conversation-shaped triggers are namespaced (`message.received` →
 * `conversation.message.received`), which is both the spec's own example name and a clearer
 * promise to a customer about what the payload is about.
 */
import { createHash } from 'node:crypto';
import { NexusError } from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';
import { stableStringify } from '../sync/raw-store.ts';

/** Every event name a customer may subscribe to. Additive only — names are a public contract. */
export const OUTBOUND_EVENT_TYPES = [
  'record.created',
  'record.updated',
  'list.entry_added',
  'list.stage_changed',
  'conversation.message.received',
  'conversation.comment.received',
  'conversation.mention.received',
  'lead_form.submitted',
] as const;

export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

/** One line of documentation per event, rendered in the subscription UI. */
export const OUTBOUND_EVENT_DESCRIPTION: Record<OutboundEventType, string> = {
  'record.created': 'A record was created (any object type).',
  'record.updated': 'One or more attributes of a record changed.',
  'list.entry_added': 'A record was added to a list or pipeline.',
  'list.stage_changed': 'A pipeline entry moved to a different stage.',
  'conversation.message.received': 'An inbound DM or email arrived.',
  'conversation.comment.received': 'An inbound comment arrived.',
  'conversation.mention.received': 'The account was mentioned.',
  'lead_form.submitted': 'A lead form was submitted.',
};

export function isOutboundEventType(value: string): value is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

/** What a caller hands the fan-out: a public event name plus the data to deliver. */
export type OutboundWebhookEvent = {
  workspaceId: string;
  eventType: OutboundEventType;
  /** The `data` object of the delivered body. */
  payload: Record<string, unknown>;
  occurredAt?: Date;
  /**
   * Extra material folded into the idempotency key. Pass the id of the thing that happened (a
   * `TimelineEvent` id, a list entry id) when the payload alone could repeat — e.g. two identical
   * `record.updated` payloads a minute apart are genuinely two events.
   */
  dedupeKey?: string | null;
};

/** A delivery row that exists and is waiting for its first POST. */
export type PendingOutboundDelivery = {
  deliveryId: string;
  workspaceId: string;
  subscriptionId: string;
  eventType: string;
  /** Attempts already made. 0 for a fresh delivery, >0 for a retry or a replay. */
  attempts: number;
};

/** How a caller gets a delivery onto a queue. Keeps this package free of queue knowledge. */
export type OutboundWebhookEnqueue = (delivery: PendingOutboundDelivery) => Promise<void>;

/**
 * The `(subscriptionId, idempotencyKey)` half of the `@@unique([workspaceId, subscriptionId,
 * idempotencyKey])` guard: a straightforward hash of the stable identifying fields, so calling
 * `dispatchOutboundWebhookEvent` twice for the same underlying event cannot create two delivery
 * rows for the same subscription. Key order in the payload is irrelevant (`stableStringify`).
 */
export function outboundIdempotencyKeyFor(parts: {
  subscriptionId: string;
  eventType: string;
  payload: unknown;
  dedupeKey?: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        parts.subscriptionId,
        parts.eventType,
        parts.dedupeKey ?? '',
        stableStringify(parts.payload),
      ].join('\n'),
    )
    .digest('hex');
}

export type DispatchResult = {
  /** Deliveries created by this call, in subscription order. */
  created: PendingOutboundDelivery[];
  /** Subscriptions that already had a delivery row for this exact event. */
  duplicates: number;
};

/**
 * Fan one event out to every enabled subscription that asked for it, inside the caller's
 * transaction, then enqueue each new delivery. Returns without touching the queue when nobody
 * subscribes — the overwhelmingly common case, and one indexed query
 * (`@@index([workspaceId, enabled])`).
 */
export async function dispatchOutboundWebhookEvent(
  db: TenantDb,
  enqueue: OutboundWebhookEnqueue,
  event: OutboundWebhookEvent,
): Promise<DispatchResult> {
  const subscriptions = await db.outboundWebhookSubscription.findMany({
    where: { deletedAt: null, enabled: true, events: { has: event.eventType } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const result: DispatchResult = { created: [], duplicates: 0 };
  if (subscriptions.length === 0) return result;

  const payload = event.payload as Prisma.InputJsonValue;
  for (const subscription of subscriptions) {
    const idempotencyKey = outboundIdempotencyKeyFor({
      subscriptionId: subscription.id,
      eventType: event.eventType,
      payload: event.payload,
      dedupeKey: event.dedupeKey ?? null,
    });
    const existing = await db.outboundWebhookDelivery.findFirst({
      where: { subscriptionId: subscription.id, idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      result.duplicates += 1;
      continue;
    }
    const row = await db.outboundWebhookDelivery.create({
      data: {
        workspaceId: event.workspaceId,
        subscriptionId: subscription.id,
        eventType: event.eventType,
        payload,
        idempotencyKey,
        status: 'PENDING',
        nextAttemptAt: event.occurredAt ?? new Date(),
      },
      select: { id: true },
    });
    result.created.push({
      deliveryId: row.id,
      workspaceId: event.workspaceId,
      subscriptionId: subscription.id,
      eventType: event.eventType,
      attempts: 0,
    });
  }
  for (const delivery of result.created) await enqueue(delivery);
  return result;
}

/** Reject an unknown event name at the edge with the taxonomy's VALIDATION class. */
export function assertOutboundEventTypes(events: string[]): OutboundEventType[] {
  const unknown = events.filter((e) => !isOutboundEventType(e));
  if (unknown.length)
    throw new NexusError('VALIDATION', {
      context: { reason: `Unknown webhook event name: ${unknown.join(', ')}.` },
    });
  return events as OutboundEventType[];
}
