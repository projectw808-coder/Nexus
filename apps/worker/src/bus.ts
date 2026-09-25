/**
 * BullMQ implementation of the engine's `JobBus` (ADR-005: lanes are priorities inside
 * per-stage queues). Producers get one lazily-created Queue per stage; the retry policy is the
 * §9.2 one — six attempts, exponential backoff with full jitter — expressed as a custom BullMQ
 * backoff strategy so both hosts behave identically.
 */
import { QUEUE_PREFIX, type QueueName } from '@nexus/config';
import { LANE_PRIORITY, MAX_ATTEMPTS, nextDelayMs } from '@nexus/connector-sdk';
import type { JobBus, JobEnvelope } from '@nexus/sync';
import { Queue, type ConnectionOptions } from 'bullmq';

export const DEFAULT_JOB_OPTIONS = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'nexus' as const },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

/** Worker-side `settings.backoffStrategy` for `backoff: { type: 'nexus' }`. */
export function nexusBackoffStrategy(attemptsMade: number, _type?: string, err?: Error): number {
  return nextDelayMs(Math.max(0, attemptsMade - 1), err);
}

export function createBullBus(
  connection: ConnectionOptions,
): JobBus & { queue(name: QueueName): Queue; close(): Promise<void> } {
  const queues = new Map<QueueName, Queue>();
  const queue = (name: QueueName): Queue => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection,
        prefix: QUEUE_PREFIX,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      queues.set(name, q);
    }
    return q;
  };
  return {
    queue,
    async enqueue<T>(job: JobEnvelope<T>) {
      const added = await queue(job.queue).add(job.name, job.data, {
        ...(job.opts?.jobId ? { jobId: job.opts.jobId } : {}),
        priority: LANE_PRIORITY[job.opts?.lane ?? 'delta'] + 1,
        ...(job.opts?.delayMs ? { delay: job.opts.delayMs } : {}),
        ...(job.opts?.attempts ? { attempts: job.opts.attempts } : {}),
      });
      return { jobId: added.id ?? job.opts?.jobId ?? 'unknown', mode: 'queued' as const };
    },
    async close() {
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
    },
  };
}
