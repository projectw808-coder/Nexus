/**
 * The sync engine as seen from the web tier: a process-wide `SyncDeps` whose bus enqueues to
 * BullMQ when Redis is reachable and otherwise runs the engine inline (ADR-010), so the mock
 * platform can be connected and synced on a laptop with no infrastructure at all.
 */
import { loadEnv, QUEUE_PREFIX, QUEUES } from '@nexus/config';
import { LANE_PRIORITY, MAX_ATTEMPTS } from '@nexus/connector-sdk';
import { createLogger } from '@nexus/telemetry';
import {
  createInlineBus,
  createSyncDeps,
  deadLetterJob,
  handleJob,
  sdkLoggerFrom,
  type JobBus,
  type JobEnvelope,
  type SyncDeps,
} from '@nexus/sync';
import type { Queue } from 'bullmq';

const log = createLogger({ name: 'nexus-web-sync', level: 'info' });
const g = globalThis as unknown as { __nexusSync?: Promise<SyncDeps> };

async function bullQueues(): Promise<Map<string, Queue> | null> {
  const env = loadEnv();
  try {
    const [{ default: IORedis }, { Queue }] = await Promise.all([
      import('ioredis'),
      import('bullmq'),
    ]);
    const redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 1500,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
    await Promise.race([
      redis.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('redis timeout')), 1500)),
    ]);
    const queues = new Map<string, Queue>();
    for (const name of [
      QUEUES.syncBackfill,
      QUEUES.syncDelta,
      QUEUES.ingestRaw,
      QUEUES.normalize,
      QUEUES.outbound,
    ]) {
      queues.set(
        name,
        new Queue(name, {
          connection: redis,
          prefix: QUEUE_PREFIX,
          defaultJobOptions: {
            attempts: MAX_ATTEMPTS,
            backoff: { type: 'nexus' },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        }),
      );
    }
    return queues;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'Redis unreachable — the sync engine runs inline in the web process',
    );
    return null;
  }
}

function bullBus(queues: Map<string, Queue>): JobBus {
  return {
    async enqueue<T>(job: JobEnvelope<T>) {
      const q = queues.get(job.queue);
      if (!q) throw new Error(`no queue ${job.queue}`);
      const added = await q.add(job.name, job.data, {
        ...(job.opts?.jobId ? { jobId: job.opts.jobId } : {}),
        priority: LANE_PRIORITY[job.opts?.lane ?? 'delta'] + 1,
        ...(job.opts?.delayMs ? { delay: job.opts.delayMs } : {}),
      });
      return { jobId: added.id ?? 'unknown', mode: 'queued' as const };
    },
  };
}

async function build(): Promise<SyncDeps> {
  const env = loadEnv();
  const queues = await bullQueues();
  const logger = sdkLoggerFrom(log);
  if (queues) return createSyncDeps({ env, bus: bullBus(queues), logger });
  // Inline: the same handlers the worker runs, on this process's event loop.
  const holder: { deps: SyncDeps | null } = { deps: null };
  const bus = createInlineBus({
    handlers: {
      [QUEUES.syncBackfill]: (j) => handleJob(holder.deps!, j),
      [QUEUES.syncDelta]: (j) => handleJob(holder.deps!, j),
      [QUEUES.ingestRaw]: (j) => handleJob(holder.deps!, j),
      [QUEUES.normalize]: (j) => handleJob(holder.deps!, j),
      [QUEUES.outbound]: (j) => handleJob(holder.deps!, j),
    },
    onDeadLetter: (job, error) => deadLetterJob(holder.deps!, job, error),
    logger,
    concurrency: 2,
  });
  holder.deps = createSyncDeps({ env, bus, logger });
  return holder.deps;
}

/** Process-wide engine handle (cached on globalThis so Next's HMR does not rebuild it per reload). */
export function getSyncDeps(): Promise<SyncDeps> {
  g.__nexusSync ??= build();
  return g.__nexusSync;
}
