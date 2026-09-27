/**
 * Stage 6 (§4.1 "React"): after stage 5 materializes a batch, evaluate automation triggers.
 * Rather than threading a hook through every sink, this queries the `TimelineEvent` rows the
 * batch's materialize call just created — `@@index([workspaceId, externalObjectId])` exists for
 * exactly this — and enqueues one plain-data `AutomationEvent` per event onto `QUEUES.automate`
 * (ADR-021 decision 2). This package depends on `@nexus/automation` only for that shared type; it
 * never imports the engine that consumes these events.
 */
import { QUEUES } from '@nexus/config';
import { type AutomationEvent, type TriggerType } from '@nexus/automation';
import { systemActorFor } from '@nexus/db';
import type { SyncDeps } from './deps.ts';
import { dispatchOutboundWebhooksForEvent } from './outbound-webhooks.ts';

/** Inbound-only TimelineTypes that correspond to a trigger; anything else is not reacted to. */
const EVENT_TYPE_FOR: Partial<Record<string, TriggerType>> = {
  MESSAGE: 'message.received',
  COMMENT: 'comment.received',
  MENTION: 'mention.received',
  LEAD_FORM: 'lead_form.submitted',
};

export const AUTOMATE_JOB = 'automate.react';

/**
 * Enqueue an `AutomationEvent` for every newly materialized `TimelineEvent` tied to this batch's
 * objects. Called once per `normalizeObjects` call, after `sink.materialize` resolves. Never
 * throws on an individual mapping problem — a batch of otherwise-successful ingestion should not
 * fail because stage 6 couldn't resolve a conversation id.
 */
export async function enqueueAutomationEventsForObjects(
  deps: SyncDeps,
  input: { workspaceId: string; connectionId: string; objectIds: string[] },
): Promise<{ enqueued: number }> {
  if (input.objectIds.length === 0) return { enqueued: 0 };
  const actor = systemActorFor(input.workspaceId, input.connectionId);
  const rows = await deps.runtime.withTenant(actor, (db) =>
    db.timelineEvent.findMany({
      where: { externalObjectId: { in: input.objectIds }, deletedAt: null },
      select: {
        id: true,
        type: true,
        platform: true,
        connectionId: true,
        recordId: true,
        identityId: true,
        occurredAt: true,
        payload: true,
      },
    }),
  );
  let enqueued = 0;
  for (const row of rows) {
    const type = EVENT_TYPE_FOR[row.type];
    if (!type) continue;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // Never react to our own outbound echo — "message received" means inbound.
    if (payload['direction'] === 'outbound') continue;

    let conversationId: string | null = null;
    const conversationExternalId = payload['conversationExternalId'];
    if (typeof conversationExternalId === 'string' && row.connectionId) {
      const conv = await deps.runtime.withTenant(actor, (db) =>
        db.conversation.findFirst({
          where: { connectionId: row.connectionId!, externalId: conversationExternalId },
          select: { id: true },
        }),
      );
      conversationId = conv?.id ?? null;
    }

    const event: AutomationEvent = {
      workspaceId: input.workspaceId,
      type,
      occurredAt: row.occurredAt.toISOString(),
      platform: row.platform ?? null,
      connectionId: row.connectionId ?? null,
      recordId: row.recordId ?? null,
      identityId: row.identityId ?? null,
      conversationId,
      timelineEventId: row.id,
      payload,
      causation: { workflowIds: [] },
    };
    await deps.bus.enqueue({
      queue: QUEUES.automate,
      name: AUTOMATE_JOB,
      data: event,
      opts: { jobId: `automate-${row.id}` },
    });
    // Second, independent consumer of the same event (ADR-022 decision 4): customer-facing
    // outbound webhooks. Never throws — a subscription problem cannot fail stage 6.
    await dispatchOutboundWebhooksForEvent(deps, event);
    enqueued += 1;
  }
  return { enqueued };
}
