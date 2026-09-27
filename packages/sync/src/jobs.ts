/**
 * Queue payloads (validated with Zod on both ends — spec §3 "Validation at every boundary")
 * and the single dispatcher both hosts call: the BullMQ processors in apps/worker and the
 * inline bus. Every payload carries `workspaceId` so the dead-letter hook can file it under
 * the right tenant.
 */
import { z } from 'zod';
import { QUEUES } from '@nexus/config';
import { laneSchema } from '@nexus/connector-sdk';
import { recordDeadLetter, systemActorFor } from '@nexus/db';
import type { ActiveJob } from './bus.ts';
import type { SyncDeps } from './deps.ts';
import { executeOutbound } from './outbound.ts';
import { normalizeObjects } from './stages/normalize.ts';
import { runResourceSync } from './stages/acquire.ts';
import { processWebhookEvent } from './webhooks.ts';

export const syncJobSchema = z.object({
  workspaceId: z.string().min(1),
  connectionId: z.string().min(1),
  resource: z.string().min(1),
  trigger: z.enum(['BACKFILL', 'SCHEDULE', 'WEBHOOK', 'MANUAL', 'REPLAY']),
  lane: laneSchema,
  /** Pages per job before yielding back to the queue (keeps a 50k backfill resumable and fair). */
  maxPages: z.number().int().positive().optional(),
});
export type SyncJob = z.infer<typeof syncJobSchema>;

export const normalizeJobSchema = z.object({
  workspaceId: z.string().min(1),
  connectionId: z.string().min(1),
  objectIds: z.array(z.string().min(1)).min(1),
  /** Replay from `materialize`: re-run the sink without resetting stamps. */
  force: z.boolean().optional(),
});
export type NormalizeJob = z.infer<typeof normalizeJobSchema>;

export const ingestRawJobSchema = z.object({
  workspaceId: z.string().min(1),
  connectionId: z.string().min(1),
  eventId: z.string().min(1),
});
export type IngestRawJob = z.infer<typeof ingestRawJobSchema>;

export const outboundJobSchema = z.object({
  workspaceId: z.string().min(1),
  connectionId: z.string().min(1),
  outboundActionId: z.string().min(1),
});
export type OutboundJobData = z.infer<typeof outboundJobSchema>;

export const JOB_NAMES = {
  sync: 'sync',
  normalize: 'normalize',
  ingestWebhook: 'ingest.webhook',
  outbound: 'outbound.execute',
} as const;

/** BullMQ rejects a custom job id containing `:` (its own Redis keys use it as a delimiter) —
 * `-` throughout every job id in this file and its callers. */
export function syncJobId(job: Pick<SyncJob, 'connectionId' | 'resource' | 'trigger'>): string {
  return `sync-${job.connectionId}-${job.resource}-${job.trigger}`;
}

/** One entry point per queue; the hosts only parse the queue name. */
export async function handleJob(deps: SyncDeps, job: ActiveJob): Promise<unknown> {
  switch (job.queue) {
    case QUEUES.syncBackfill:
    case QUEUES.syncDelta: {
      const data = syncJobSchema.parse(job.data);
      return runResourceSync(deps, { ...data, signal: job.signal, attempt: job.attemptsMade });
    }
    case QUEUES.normalize: {
      const data = normalizeJobSchema.parse(job.data);
      return normalizeObjects(deps, data);
    }
    case QUEUES.ingestRaw: {
      const data = ingestRawJobSchema.parse(job.data);
      return processWebhookEvent(deps, data);
    }
    case QUEUES.outbound: {
      const data = outboundJobSchema.parse(job.data);
      return executeOutbound(deps, data);
    }
    default:
      throw new Error(`the sync engine has no handler for queue ${job.queue}`);
  }
}

/** Dead-letter hook: file the exhausted job under its tenant for one-click replay. */
export async function deadLetterJob(deps: SyncDeps, job: ActiveJob, error: unknown): Promise<void> {
  const data = job.data as { workspaceId?: unknown; connectionId?: unknown };
  const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : null;
  if (!workspaceId) {
    deps.logger.error('dead-lettered job has no workspaceId; cannot file it', {
      queue: job.queue,
      name: job.name,
      jobId: job.id,
    });
    return;
  }
  const connectionId = typeof data.connectionId === 'string' ? data.connectionId : null;
  await deps.runtime.withTenant(systemActorFor(workspaceId, connectionId ?? undefined), (db) =>
    recordDeadLetter(db, {
      workspaceId,
      connectionId,
      queue: job.queue,
      jobName: job.name,
      payload: job.data,
      error,
      attempts: job.attemptsMade,
    }),
  );
}
