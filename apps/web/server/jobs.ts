/**
 * Job dispatch from the web tier (ADR-010). Jobs go to the BullMQ `system` queue when Redis is
 * reachable; otherwise (a developer machine without Redis) they run inline in this process
 * after the current request. Either way the caller's transaction has committed first.
 */
import { QUEUE_PREFIX, QUEUES, loadEnv } from '@nexus/config';
import {
  runIndexBuild,
  dropIndexArtifacts,
  purgeDeletedAttributes,
  runtime as defaultRuntime,
  type TenantRuntime,
} from '@nexus/db';
import { createLogger } from '@nexus/telemetry';
import type { Queue } from 'bullmq';

export type JobName = 'index.build' | 'index.drop' | 'attribute.purge';
export type JobPayload = {
  'index.build': { attributeId: string };
  'index.drop': { attributeId: string };
  'attribute.purge': Record<string, never>;
};

export type JobDispatcher = {
  dispatch<N extends JobName>(
    name: N,
    payload: JobPayload[N],
  ): Promise<{ mode: 'queued' | 'inline' }>;
};

const log = createLogger({ name: 'nexus-web-jobs', level: 'info' });

export async function runJobInline(
  runtime: TenantRuntime,
  name: JobName,
  payload: JobPayload[JobName],
): Promise<void> {
  switch (name) {
    case 'index.build':
      await runIndexBuild(runtime, (payload as JobPayload['index.build']).attributeId);
      return;
    case 'index.drop':
      await dropIndexArtifacts(runtime, (payload as JobPayload['index.drop']).attributeId);
      return;
    case 'attribute.purge':
      await purgeDeletedAttributes(runtime);
      return;
  }
}

let queuePromise: Promise<Queue | null> | undefined;

async function systemQueue(): Promise<Queue | null> {
  queuePromise ??= (async () => {
    try {
      const env = loadEnv();
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
      return new Queue(QUEUES.system, {
        connection: redis,
        prefix: QUEUE_PREFIX,
        defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 3 },
      });
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'Redis unreachable — jobs will run inline in the web process',
      );
      return null;
    }
  })();
  return queuePromise;
}

export function createDispatcher(runtime: TenantRuntime = defaultRuntime): JobDispatcher {
  return {
    async dispatch(name, payload) {
      const queue = await systemQueue();
      if (queue) {
        await queue.add(name, payload, {
          jobId: `${name}:${'attributeId' in payload ? payload.attributeId : 'global'}:${Date.now()}`,
        });
        return { mode: 'queued' };
      }
      setTimeout(() => {
        runJobInline(runtime, name, payload).catch((e: unknown) =>
          log.error({ err: e, job: name }, 'inline job failed'),
        );
      }, 0);
      return { mode: 'inline' };
    },
  };
}

/** Test double: records dispatches, runs nothing. */
export function recordingDispatcher(): JobDispatcher & {
  calls: { name: JobName; payload: unknown }[];
} {
  const calls: { name: JobName; payload: unknown }[] = [];
  return {
    calls,
    async dispatch(name, payload) {
      calls.push({ name, payload });
      return { mode: 'inline' };
    },
  };
}
