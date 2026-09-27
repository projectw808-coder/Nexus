/**
 * Hosts the sync engine (spec §9) in the worker: one BullMQ Worker per pipeline queue, the
 * poll planner that turns enabled resources into repeating job schedulers, the hourly token
 * sweep, and the startup recovery (stale runs, un-normalized rows). Every job runs inside a
 * consumer span joined to the producer's trace.
 */
import { loadEnv, QUEUE_PREFIX, QUEUES, type QueueName } from '@nexus/config';
import { LANE_PRIORITY } from '@nexus/connector-sdk';
import {
  listSchedulableConnections,
  cancelStaleRuns,
  sweepSnoozed,
  systemActorFor,
  runtime,
} from '@nexus/db';
import { getMailProvider } from '@nexus/mail';
import {
  createSyncDeps,
  deadLetterJob,
  handleJob,
  mailNotifier,
  planDeltaPolls,
  requeuePendingNormalization,
  runIdentityRescore,
  runMetaVersionMonitor,
  sdkLoggerFrom,
  sweepTokens,
  JOB_NAMES,
  type SyncDeps,
} from '@nexus/sync';
import {
  runWithTraceCarrier,
  TRACE_CARRIER_KEY,
  withLogContext,
  type Logger,
  type TraceCarrier,
} from '@nexus/telemetry';
import { Queue, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { createBullBus, nexusBackoffStrategy } from './bus.ts';

const PIPELINE_QUEUES: { name: QueueName; concurrency: number }[] = [
  { name: QUEUES.syncBackfill, concurrency: 2 },
  { name: QUEUES.syncDelta, concurrency: 4 },
  { name: QUEUES.ingestRaw, concurrency: 8 },
  { name: QUEUES.normalize, concurrency: 4 },
  { name: QUEUES.outbound, concurrency: 4 },
];

export const SYNC_SYSTEM_JOBS = {
  pollPlan: 'sync.poll_plan',
  tokenSweep: 'token.sweep',
  recover: 'sync.recover',
  metaVersion: 'meta.version_monitor',
  identityRescore: 'identity.rescore',
  unsnooze: 'inbox.unsnooze',
} as const;

export type SyncHost = {
  deps: SyncDeps;
  bus: ReturnType<typeof createBullBus>;
  workers: Record<string, Worker>;
  close(): Promise<void>;
};

export function startSyncHost(opts: { redis: IORedis; log: Logger }): SyncHost {
  const env = loadEnv();
  const bus = createBullBus(opts.redis);
  const deps = createSyncDeps({
    env,
    bus,
    logger: sdkLoggerFrom(opts.log),
    redis: opts.redis,
    runtime,
  });

  const traced =
    <T extends { [TRACE_CARRIER_KEY]?: TraceCarrier }, R>(
      queue: string,
      fn: (job: Job<T>) => Promise<R>,
    ) =>
    (job: Job<T>): Promise<R> =>
      runWithTraceCarrier(job.data[TRACE_CARRIER_KEY], `${queue}.${job.name}`, () => fn(job), {
        'messaging.system': 'bullmq',
        'messaging.destination.name': queue,
        'messaging.message.id': job.id ?? '',
        'nexus.job.attempt': job.attemptsMade + 1,
      });

  const workers: Record<string, Worker> = {};
  for (const q of PIPELINE_QUEUES) {
    const worker = new Worker(
      q.name,
      traced(q.name, async (job: Job<Record<string, unknown>>) => {
        const controller = new AbortController();
        return handleJob(deps, {
          id: job.id ?? 'unknown',
          queue: q.name,
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
          signal: controller.signal,
        });
      }),
      {
        connection: opts.redis,
        prefix: QUEUE_PREFIX,
        concurrency: q.concurrency,
        settings: { backoffStrategy: nexusBackoffStrategy },
      },
    );
    worker.on('failed', (job, error) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const log = withLogContext(opts.log, { jobId: job.id });
      if (job.attemptsMade >= attempts) {
        log.error(
          { queue: q.name, name: job.name, err: error },
          'job exhausted its retries; dead-lettering',
        );
        void deadLetterJob(
          deps,
          {
            id: job.id ?? 'unknown',
            queue: q.name,
            name: job.name,
            data: job.data,
            attemptsMade: job.attemptsMade,
            signal: new AbortController().signal,
          },
          error,
        );
      } else {
        log.warn(
          { queue: q.name, name: job.name, attempt: job.attemptsMade, err: error.message },
          'job failed; will retry',
        );
      }
    });
    worker.on('error', (error) => opts.log.error({ queue: q.name, err: error }, 'worker error'));
    workers[q.name] = worker;
  }

  // Housekeeping on the system queue: plan polls every 5 minutes, sweep tokens hourly, recover at boot.
  const system = new Queue(QUEUES.system, { connection: opts.redis, prefix: QUEUE_PREFIX });
  void (async () => {
    try {
      await system.upsertJobScheduler(
        SYNC_SYSTEM_JOBS.pollPlan,
        { every: 5 * 60_000 },
        { name: SYNC_SYSTEM_JOBS.pollPlan, data: {} },
      );
      await system.upsertJobScheduler(
        SYNC_SYSTEM_JOBS.tokenSweep,
        { every: 60 * 60_000 },
        { name: SYNC_SYSTEM_JOBS.tokenSweep, data: {} },
      );
      // Snoozed conversations come back every minute (§12.2.A).
      await system.upsertJobScheduler(
        SYNC_SYSTEM_JOBS.unsnooze,
        { every: 60_000 },
        { name: SYNC_SYSTEM_JOBS.unsnooze, data: {} },
      );
      // Nightly identity re-score (§10): open suggestions, unresolved identities, duplicate scan.
      await system.upsertJobScheduler(
        SYNC_SYSTEM_JOBS.identityRescore,
        { every: 24 * 60 * 60_000 },
        { name: SYNC_SYSTEM_JOBS.identityRescore, data: {} },
      );
      await system.upsertJobScheduler(
        SYNC_SYSTEM_JOBS.metaVersion,
        { every: 7 * 24 * 60 * 60_000 },
        { name: SYNC_SYSTEM_JOBS.metaVersion, data: {} },
      );
      await system.add(
        SYNC_SYSTEM_JOBS.recover,
        {},
        { jobId: `${SYNC_SYSTEM_JOBS.recover}-${Date.now()}` },
      );
    } catch (e) {
      opts.log.warn({ err: e }, 'could not schedule sync housekeeping');
    }
  })();

  return {
    deps,
    bus,
    workers,
    async close() {
      await Promise.allSettled([
        ...Object.values(workers).map((w) => w.close()),
        system.close(),
        bus.close(),
      ]);
    },
  };
}

/** System-queue handlers the sync host contributes (called from processors/system.ts). */
export async function handleSyncSystemJob(
  host: SyncHost,
  name: string,
  log: Logger,
): Promise<unknown> {
  const { deps } = host;
  switch (name) {
    case SYNC_SYSTEM_JOBS.pollPlan: {
      const plan = await planDeltaPolls(deps);
      const delta = host.bus.queue(QUEUES.syncDelta);
      {
        for (const p of plan) {
          await delta.upsertJobScheduler(
            p.jobId,
            { every: p.intervalSeconds * 1000 },
            { name: JOB_NAMES.sync, data: p.job, opts: { priority: LANE_PRIORITY.delta + 1 } },
          );
        }
        // Retire schedulers for connections/resources no longer planned.
        const live = new Set(plan.map((p) => p.jobId));
        for (const s of await delta.getJobSchedulers(0, 10_000))
          if (s.key && s.key.startsWith('sync:') && !live.has(s.key))
            await delta.removeJobScheduler(s.key);
      }
      log.info({ polls: plan.length }, 'delta polls planned');
      return { polls: plan.length };
    }
    case SYNC_SYSTEM_JOBS.metaVersion: {
      const result = await runMetaVersionMonitor(deps, {
        feedUrl: loadEnv().META_VERSIONS_FEED_URL ?? null,
      });
      log.info(result, 'Meta version monitor finished');
      return result;
    }
    case SYNC_SYSTEM_JOBS.unsnooze: {
      const result = await sweepSnoozed(runtime);
      if (result.reopened) log.info(result, 'snoozed conversations reopened');
      return result;
    }
    case SYNC_SYSTEM_JOBS.identityRescore: {
      const result = await runIdentityRescore(deps);
      log.info(result, 'identity re-score finished');
      return result;
    }
    case SYNC_SYSTEM_JOBS.tokenSweep: {
      const notifier = mailNotifier({
        mail: getMailProvider(),
        appUrl: deps.appUrl ?? loadEnv().APP_URL,
        log: deps.logger,
      });
      const result = await sweepTokens(deps, { notifier });
      log.info(result, 'token sweep finished');
      return result;
    }
    case SYNC_SYSTEM_JOBS.recover: {
      const connections = await listSchedulableConnections(deps.runtime);
      let requeued = 0;
      for (const c of connections) {
        await deps.runtime.withTenant(systemActorFor(c.workspaceId, c.id), (db) =>
          cancelStaleRuns(db, c.id, new Date(Date.now() - 60 * 60_000)),
        );
        requeued += (
          await requeuePendingNormalization(deps, {
            workspaceId: c.workspaceId,
            connectionId: c.id,
          })
        ).objects;
      }
      log.info({ connections: connections.length, requeued }, 'sync recovery finished');
      return { connections: connections.length, requeued };
    }
    default:
      return undefined;
  }
}
