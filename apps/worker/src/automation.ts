/**
 * Hosts the `automate` queue (spec §14, ADR-021): the one place `@nexus/automation`,
 * `@nexus/sync` and `@nexus/mail` come together, since the engine itself imports none of them —
 * every platform-specific side effect arrives here as an injected callback.
 */
import { QUEUE_PREFIX, QUEUES } from '@nexus/config';
import {
  automationEventSchema,
  createAutomationRuntime,
  reactToEvent,
  type AutomationRuntime,
} from '@nexus/automation';
import { runtime, systemActorFor } from '@nexus/db';
import { escapeHtml, getMailProvider } from '@nexus/mail';
import { requestReply, type SyncDeps } from '@nexus/sync';
import type { Logger } from '@nexus/telemetry';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';

export type AutomationHost = { worker: Worker; close(): Promise<void> };

export function buildAutomationRuntime(syncDeps: SyncDeps): AutomationRuntime {
  return createAutomationRuntime({
    runtime,
    enqueueEvent: async (event) => {
      await syncDeps.bus.enqueue({
        queue: QUEUES.automate,
        name: 'automate.react',
        data: event,
        opts: {
          jobId: `automate:followup:${event.workspaceId}:${event.timelineEventId ?? Date.now()}:${event.causation.workflowIds.length}`,
        },
      });
    },
    sendReply: async (input) => {
      // A workflow acts as a WORKFLOW actor (no userId of its own); OutboundAction.requestedByUserId
      // is NOT NULL, so the send is attributed to the connection's owner (ADR-021 territory — see
      // the requestReply change in @nexus/sync).
      const conv = await runtime.withTenant(systemActorFor(input.workspaceId), (db) =>
        db.conversation.findFirst({
          where: { id: input.conversationId },
          select: { connection: { select: { ownerUserId: true } } },
        }),
      );
      const requestedByUserId = conv?.connection.ownerUserId ?? undefined;
      const outcome = await requestReply(syncDeps, {
        actor: {
          workspaceId: input.workspaceId,
          userId: null,
          role: 'OWNER',
          grants: [],
          actorType: 'WORKFLOW',
          actorRef: null,
        },
        conversationId: input.conversationId,
        text: input.text,
        requestNonce: `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        requestedByUserId,
      });
      return {
        status: outcome.status,
        outboundActionId: 'outboundActionId' in outcome ? outcome.outboundActionId : undefined,
      };
    },
    sendEmail: async (input) => {
      const result = await getMailProvider().send({
        to: input.to,
        subject: input.subject,
        html: `<p>${escapeHtml(input.body).replace(/\n/g, '<br>')}</p>`,
        text: input.body,
        kind: 'automation.send_email',
      });
      if (!result.ok) throw result.error;
    },
    enqueueAi: async (input) => {
      await syncDeps.bus.enqueue({
        queue: QUEUES.aiEnrich,
        name: 'ai.run',
        data: input,
      });
    },
  });
}

export function startAutomationHost(opts: {
  redis: IORedis;
  log: Logger;
  syncDeps: SyncDeps;
}): AutomationHost {
  const rt = buildAutomationRuntime(opts.syncDeps);
  const worker = new Worker(
    QUEUES.automate,
    async (job: Job) => {
      const event = automationEventSchema.parse(job.data);
      return reactToEvent(rt, event);
    },
    { connection: opts.redis, prefix: QUEUE_PREFIX, concurrency: 4 },
  );
  worker.on('failed', (job, error) => {
    opts.log.error({ jobId: job?.id, err: error }, 'automation job failed');
  });
  worker.on('error', (error) => opts.log.error({ err: error }, 'automation worker error'));
  return {
    worker,
    async close() {
      await worker.close();
    },
  };
}
