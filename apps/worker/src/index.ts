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
import { Worker, type Job } from 'bullmq';
import { startHealthServer } from './health.ts';
import { handleSystemJob, type SystemJobData } from './processors/system.ts';
import { createRedis } from './redis.ts';

const env = loadEnv();
const log = createLogger({
  name: 'nexus-worker',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const connection = createRedis(env.REDIS_URL);

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
  traced(QUEUES.system, (job) => handleSystemJob(job, withLogContext(log, { jobId: job.id }))),
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

const health = startHealthServer({
  port: env.WORKER_HEALTH_PORT,
  redis: connection,
  workers: { [QUEUES.system]: systemWorker },
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
  await Promise.allSettled([systemWorker.close(), health.close()]);
  await connection.quit().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info(
  {
    queues: [QUEUES.system],
    healthPort: env.WORKER_HEALTH_PORT,
    otlp: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  },
  'worker started',
);
