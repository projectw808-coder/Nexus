import { dropIndexArtifacts, purgeDeletedAttributes, runIndexBuild, runtime } from '@nexus/db';
import type { Logger, TraceCarrier } from '@nexus/telemetry';
import type { TRACE_CARRIER_KEY } from '@nexus/telemetry';
import type { Job } from 'bullmq';

export type SystemJobData = {
  sentAt?: string;
  attributeId?: string;
  [TRACE_CARRIER_KEY]?: TraceCarrier;
};

export type SystemJobResult =
  | { pong: true; receivedAt: string; queueLatencyMs: number | null }
  | { attributeId: string; state: 'READY' | 'DROPPED' }
  | { purged: string[] };

/**
 * Processors for the `system` queue: the trace ping, generated-column index builds/drops
 * (ADR-009) and the nightly purge of attributes past their 24h retention.
 */
export async function handleSystemJob(
  job: Job<SystemJobData>,
  log: Logger,
): Promise<SystemJobResult> {
  switch (job.name) {
    case 'ping': {
      const receivedAt = new Date();
      const sentAt = job.data.sentAt ? new Date(job.data.sentAt) : null;
      const queueLatencyMs = sentAt ? receivedAt.getTime() - sentAt.getTime() : null;
      log.info({ queueLatencyMs }, 'ping received');
      return { pong: true, receivedAt: receivedAt.toISOString(), queueLatencyMs };
    }
    case 'index.build': {
      const attributeId = requireAttribute(job);
      await runIndexBuild(runtime, attributeId, (p) => {
        void job.updateProgress(p.total === 0 ? 100 : Math.round((p.done / p.total) * 100));
      });
      log.info({ attributeId }, 'index built');
      return { attributeId, state: 'READY' };
    }
    case 'index.drop': {
      const attributeId = requireAttribute(job);
      await dropIndexArtifacts(runtime, attributeId);
      log.info({ attributeId }, 'index dropped');
      return { attributeId, state: 'DROPPED' };
    }
    case 'attribute.purge': {
      const purged = await purgeDeletedAttributes(runtime);
      if (purged.length > 0) log.info({ purged }, 'purged deleted attributes');
      return { purged };
    }
    default:
      throw new Error(`unknown system job: ${job.name}`);
  }
}

function requireAttribute(job: Job<SystemJobData>): string {
  const id = job.data.attributeId;
  if (!id) throw new Error(`${job.name}: attributeId missing`);
  return id;
}
