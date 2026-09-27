/**
 * Outbound webhooks, queue side (§11.2, ADR-022 decision 4).
 *
 * This is the layer that knows both vocabularies: Phase 10's internal `AutomationEvent.type`
 * (`@nexus/automation`, imported for its types only — never its engine, exactly as `react.ts`
 * does) and the public event names a customer subscribes to (`@nexus/db`'s
 * `OUTBOUND_EVENT_TYPES`). The mapping between them is the small explicit table below, keyed by
 * `TriggerType` so a new trigger type cannot be added without deciding whether it is public.
 *
 * Everything here is additive to the call sites Phase 10 already established: one extra call
 * beside the existing `automate.react` dispatch, and a second consumer of the same event data.
 */
import { QUEUES } from '@nexus/config';
import { type AutomationEvent, type TriggerType } from '@nexus/automation';
import {
  dispatchOutboundWebhookEvent,
  runOutboundWebhookDelivery,
  sweepDueOutboundDeliveries,
  systemActorFor,
  type DeliveryDeps,
  type DeliveryOutcome,
  type DispatchResult,
  type OutboundEventType,
  type OutboundWebhookEnqueue,
  type PendingOutboundDelivery,
  type TenantDb,
} from '@nexus/db';
import { z } from 'zod';
import type { JobBus } from './bus.ts';
import type { SyncDeps } from './deps.ts';

export const OUTBOUND_WEBHOOK_JOB = 'outbound_webhook.deliver';

export const outboundWebhookJobSchema = z.object({
  workspaceId: z.string().min(1),
  deliveryId: z.string().min(1),
  subscriptionId: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
});
export type OutboundWebhookJobData = z.infer<typeof outboundWebhookJobSchema>;

/**
 * Internal trigger → public event name. `null` means "not exposed to customers": `schedule` and
 * `webhook.inbound` are not things that happened to the customer's data, and `sla.breach_imminent`
 * / `task.overdue` / `ai.insight_produced` have no dispatch call site yet — when one lands, this
 * table is where the decision to publish them is made.
 */
export const PUBLIC_EVENT_FOR_TRIGGER: Record<TriggerType, OutboundEventType | null> = {
  'record.created': 'record.created',
  'record.updated': 'record.updated',
  'list.entry_added': 'list.entry_added',
  'list.stage_changed': 'list.stage_changed',
  'message.received': 'conversation.message.received',
  'comment.received': 'conversation.comment.received',
  'mention.received': 'conversation.mention.received',
  'lead_form.submitted': 'lead_form.submitted',
  'sla.breach_imminent': null,
  'task.overdue': null,
  schedule: null,
  'webhook.inbound': null,
  'ai.insight_produced': null,
};

export function publicEventFor(trigger: TriggerType): OutboundEventType | null {
  return PUBLIC_EVENT_FOR_TRIGGER[trigger] ?? null;
}

/** What a caller passes: the same fields the `automate.react` dispatch beside it already has. */
export type OutboundWebhookTriggerEvent = {
  workspaceId: string;
  type: TriggerType;
  payload: Record<string, unknown>;
  occurredAt?: string | Date;
  platform?: string | null;
  connectionId?: string | null;
  recordId?: string | null;
  objectTypeApiSlug?: string | null;
  identityId?: string | null;
  conversationId?: string | null;
  listId?: string | null;
  entryId?: string | null;
  timelineEventId?: string | null;
};

/**
 * The delivered `data` object: the event's identifying ids, then the event's own payload. Flat and
 * predictable on purpose — a customer reads `data.recordId` and `data.values`, not a nest of
 * envelopes. Null/undefined fields are omitted rather than sent as `null`.
 */
export function outboundWebhookData(event: OutboundWebhookTriggerEvent): Record<string, unknown> {
  const occurredAt =
    event.occurredAt instanceof Date
      ? event.occurredAt.toISOString()
      : (event.occurredAt ?? new Date().toISOString());
  const data: Record<string, unknown> = { occurredAt };
  const ids = {
    platform: event.platform,
    connectionId: event.connectionId,
    recordId: event.recordId,
    objectTypeApiSlug: event.objectTypeApiSlug,
    identityId: event.identityId,
    conversationId: event.conversationId,
    listId: event.listId,
    entryId: event.entryId,
    timelineEventId: event.timelineEventId,
  };
  for (const [key, value] of Object.entries(ids)) if (value != null) data[key] = value;
  return { ...data, ...event.payload };
}

/** Turn a `JobBus` into the enqueue callback `@nexus/db`'s fan-out takes. */
export function outboundWebhookEnqueue(bus: JobBus): OutboundWebhookEnqueue {
  return async (delivery: PendingOutboundDelivery) => {
    await bus.enqueue({
      queue: QUEUES.outboundWebhook,
      name: OUTBOUND_WEBHOOK_JOB,
      data: {
        workspaceId: delivery.workspaceId,
        deliveryId: delivery.deliveryId,
        subscriptionId: delivery.subscriptionId,
        eventType: delivery.eventType,
      } satisfies OutboundWebhookJobData,
      // The attempt is part of the id so a retry of the same delivery is a new job, while a
      // double dispatch of the same attempt collapses.
      opts: { jobId: `owh-${delivery.deliveryId}-${delivery.attempts}`, lane: 'delta' },
    });
  };
}

/** Re-enqueue one delivery after a failed attempt, or after a replay. */
export async function enqueueOutboundWebhookDelivery(
  bus: JobBus,
  job: OutboundWebhookJobData,
  opts: { attempts: number; delayMs?: number; replayNonce?: string },
): Promise<void> {
  await bus.enqueue({
    queue: QUEUES.outboundWebhook,
    name: OUTBOUND_WEBHOOK_JOB,
    data: job,
    opts: {
      // A retry of attempt N is one job; an operator-initiated replay is a new intent and gets its
      // own nonce, the same shape as the inbound webhook replay's job id (Phase 9).
      jobId: opts.replayNonce
        ? `owh:replay:${job.deliveryId}:${opts.replayNonce}`
        : `owh:${job.deliveryId}:${opts.attempts}`,
      lane: 'delta',
      ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
    },
  });
}

/**
 * Fan an event out to this workspace's subscriptions, inside the caller's transaction. Used by the
 * `apps/web` mutation call sites, which already hold a `TenantDb`.
 *
 * Never throws: a webhook subscription problem must not fail the mutation that caused the event.
 * The dispatch is best-effort by design — anything that did get a delivery row is durable and
 * retried, anything that did not is logged.
 */
export async function dispatchOutboundWebhooks(
  db: TenantDb,
  bus: JobBus,
  event: OutboundWebhookTriggerEvent,
  logger?: { error(message: string, meta?: Record<string, unknown>): void },
): Promise<DispatchResult> {
  const empty: DispatchResult = { created: [], duplicates: 0 };
  const eventType = publicEventFor(event.type);
  if (!eventType) return empty;
  try {
    return await dispatchOutboundWebhookEvent(db, outboundWebhookEnqueue(bus), {
      workspaceId: event.workspaceId,
      eventType,
      payload: outboundWebhookData(event),
      dedupeKey: event.timelineEventId ?? null,
    });
  } catch (e) {
    logger?.error('outbound webhook dispatch failed', {
      workspaceId: event.workspaceId,
      eventType,
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

/**
 * Stage 6's entry point: same as above, but opens its own tenant transaction, because
 * `react.ts` is outside one. Takes the `AutomationEvent` the loop has already built.
 */
export async function dispatchOutboundWebhooksForEvent(
  deps: SyncDeps,
  event: AutomationEvent,
): Promise<DispatchResult> {
  const empty: DispatchResult = { created: [], duplicates: 0 };
  if (!publicEventFor(event.type)) return empty;
  try {
    return await deps.runtime.withTenant(systemActorFor(event.workspaceId), (db) =>
      dispatchOutboundWebhooks(db, deps.bus, event, deps.logger),
    );
  } catch (e) {
    deps.logger.error('outbound webhook dispatch failed', {
      workspaceId: event.workspaceId,
      type: event.type,
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

/**
 * The safety net: re-enqueue every delivery whose `nextAttemptAt` has passed. A worker killed
 * between "record the failed attempt" and "re-enqueue" would otherwise leave the row sitting in
 * `FAILED` forever; the worker runs this every few minutes. Re-enqueuing is idempotent — the job
 * id is `owh:<deliveryId>:<attempts>`, so a delivery that does still have its job collapses onto
 * it, and a delivery already `DELIVERED` is skipped by the handler.
 */
export async function resumeDueOutboundWebhookDeliveries(
  deps: SyncDeps,
  input: { now?: Date; limit?: number } = {},
): Promise<{ resumed: number }> {
  const due = await sweepDueOutboundDeliveries(deps.runtime, input);
  for (const delivery of due) {
    await enqueueOutboundWebhookDelivery(
      deps.bus,
      {
        workspaceId: delivery.workspaceId,
        deliveryId: delivery.deliveryId,
        subscriptionId: delivery.subscriptionId,
        eventType: delivery.eventType,
      },
      { attempts: delivery.attempts },
    );
  }
  return { resumed: due.length };
}

/**
 * The queue handler: POST one delivery, then re-enqueue it if the §9.2 policy says to retry.
 * A failed *delivery* is not a failed *job* — the row carries the failure and the next attempt
 * time, so BullMQ's own retry stays reserved for unexpected faults (see `deliveries.ts`).
 */
export async function deliverOutboundWebhookJob(
  deps: SyncDeps,
  data: unknown,
  overrides: Partial<DeliveryDeps> = {},
): Promise<DeliveryOutcome> {
  const job = outboundWebhookJobSchema.parse(data);
  const outcome = await runOutboundWebhookDelivery(
    { runtime: deps.runtime, vault: deps.vault, now: deps.now, ...overrides },
    job,
  );
  if (outcome.retry) {
    await enqueueOutboundWebhookDelivery(deps.bus, job, {
      attempts: outcome.attempts,
      delayMs: outcome.retry.delayMs,
    });
  }
  return outcome;
}
