// Telemetry must be the first import so http/ioredis/pino are patched before use.
import './instrumentation.ts';

import { loadEnv, QUEUE_PREFIX, QUEUES } from '@nexus/config';
import {
  createLogger,
  runWithTraceCarrier,
  TRACE_CARRIER_KEY,
  withLogContext,
  type TraceCarrier,
} from '@nexus/telemetry';
import { pendingIndexBuilds, runtime } from '@nexus/db';
import { Queue, Worker, type Job } from 'bullmq';
import { startAiHost } from './ai.ts';
import { startAutomationHost } from './automation.ts';
import { COMPLIANCE_JOB_NAMES, handleComplianceJob, scheduleComplianceJobs } from './compliance.ts';
import { startHealthServer } from './health.ts';
import { startOutboundWebhookHost } from './outbound-webhooks.ts';
import { handleSystemJob, type SystemJobData } from './processors/system.ts';
import { createRedis } from './redis.ts';
import { handleSyncSystemJob, startSyncHost, SYNC_SYSTEM_JOBS } from './sync.ts';

const env = loadEnv();
const log = createLogger({
  name: 'nexus-worker',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const connection = createRedis(env.REDIS_URL);
const syncHost = startSyncHost({ redis: connection, log });
const automationHost = startAutomationHost({ redis: connection, log, syncDeps: syncHost.deps });
const aiHost = startAiHost({ redis: connection, log });
// Phase 11 — customer-facing outbound webhooks (§11.2)
const outboundWebhookHost = startOutboundWebhookHost({
  redis: connection,
  log,
  syncDeps: syncHost.deps,
});
const SYNC_JOB_NAMES = new Set<string>(Object.values(SYNC_SYSTEM_JOBS));

/** Wrap a processor so every job runs inside a consumer span joined to the producer's trace. */
function traced<T extends { [TRACE_CARRIER_KEY]?: TraceCarrier }, R>(
  queue: string,
  fn: (job: Job<T>) => Promise<R>,
) {
  return (job: Job<T>): Promise<R> =>
    runWithTraceCarrier(job.data[TRACE_CARRIER_KEY], `${queue}.${job.name}`, () => fn(job), {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queue,
      'messaging.message.id': job.id ?? '',
      'nexus.job.attempt': job.attemptsMade + 1,
    });
}

const systemWorker = new Worker<SystemJobData>(
  QUEUES.system,
  traced(QUEUES.system, (job) =>
    SYNC_JOB_NAMES.has(job.name)
      ? handleSyncSystemJob(syncHost, job.name, withLogContext(log, { jobId: job.id }))
      : COMPLIANCE_JOB_NAMES.has(job.name)
        ? handleComplianceJob(job.name, job.data, withLogContext(log, { jobId: job.id }))
        : handleSystemJob(job, withLogContext(log, { jobId: job.id })),
  ),
  { connection, prefix: QUEUE_PREFIX, concurrency: 5 },
);

systemWorker.on('completed', (job) => {
  log.debug({ queue: QUEUES.system, jobId: job.id, name: job.name }, 'job completed');
});
systemWorker.on('failed', (job, error) => {
  log.error({ queue: QUEUES.system, jobId: job?.id, name: job?.name, err: error }, 'job failed');
});
systemWorker.on('error', (error) => {
  log.error({ err: error }, 'worker error');
});

// Housekeeping schedule: purge attributes past their 24h retention every hour, and resume any
// index build a previous worker left BUILDING (or a seed requested).
const systemQueue = new Queue(QUEUES.system, { connection, prefix: QUEUE_PREFIX });
void (async () => {
  try {
    await systemQueue.upsertJobScheduler(
      'attribute.purge',
      { every: 60 * 60 * 1000 },
      { name: 'attribute.purge', data: {} },
    );
    // Phase 11 (§5.5): the daily retention purge and the platform compliance notes.
    await scheduleComplianceJobs(systemQueue, log);
    for (const attributeId of await pendingIndexBuilds(runtime)) {
      await systemQueue.add(
        'index.build',
        { attributeId },
        { jobId: `index.build:${attributeId}` },
      );
    }
  } catch (e) {
    log.warn({ err: e }, 'could not schedule housekeeping jobs');
  }
})();

const health = startHealthServer({
  port: env.WORKER_HEALTH_PORT,
  redis: connection,
  workers: {
    [QUEUES.system]: systemWorker,
    ...syncHost.workers,
    [QUEUES.automate]: automationHost.worker,
    [QUEUES.aiEnrich]: aiHost.worker,
    [QUEUES.outboundWebhook]: outboundWebhookHost.worker,
  },
  log,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => {
    log.warn('forced exit after 15s');
    process.exit(1);
  }, 15_000);
  deadline.unref();
  await Promise.allSettled([
    systemWorker.close(),
    systemQueue.close(),
    syncHost.close(),
    automationHost.close(),
    aiHost.close(),
    outboundWebhookHost.close(),
    health.close(),
  ]);
  await connection.quit().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info(
  {
    queues: [
      QUEUES.system,
      QUEUES.syncBackfill,
      QUEUES.syncDelta,
      QUEUES.ingestRaw,
      QUEUES.normalize,
    ],
    healthPort: env.WORKER_HEALTH_PORT,
    otlp: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  },
  'worker started',
);
