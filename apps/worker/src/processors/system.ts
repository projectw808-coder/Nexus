import type { Logger, TraceCarrier } from '@nexus/telemetry';
import type { TRACE_CARRIER_KEY } from '@nexus/telemetry';
import type { Job } from 'bullmq';

export type SystemJobData = {
  sentAt?: string;
  [TRACE_CARRIER_KEY]?: TraceCarrier;
};

export type SystemJobResult = { pong: true; receivedAt: string; queueLatencyMs: number | null };

/**
 * Processors for the `system` queue. Phase 0 ships only `ping`; token refresh, retention purge
 * and drift sampling register here in later phases.
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
    default:
      throw new Error(`unknown system job: ${job.name}`);
  }
}
