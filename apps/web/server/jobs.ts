/**
 * Job dispatch from the web tier (ADR-010). Jobs go to BullMQ when Redis is reachable; otherwise
 * (a developer machine without Redis) they run inline in this process after the current request.
 * Either way the caller's transaction has committed first.
 *
 * Phase 10 generalizes this from a single hardcoded `system`-queue dispatcher to one that routes
 * by job name: `index.build`/`index.drop`/`attribute.purge` still go to `system`, `automate.react`
 * (a record/list mutation re-entering stage 6, §4.1) goes to the new `automate` queue so it isn't
 * competing with housekeeping jobs for `system`'s small concurrency pool.
 */
import { QUEUE_PREFIX, QUEUES, loadEnv, type QueueName } from '@nexus/config';
import type { AutomationEvent } from '@nexus/automation';
import {
  runIndexBuild,
  dropIndexArtifacts,
  purgeDeletedAttributes,
  runtime as defaultRuntime,
  type TenantRuntime,
} from '@nexus/db';
import { createLogger } from '@nexus/telemetry';
import type { Queue } from 'bullmq';

export type JobName = 'index.build' | 'index.drop' | 'attribute.purge' | 'automate.react';
export type JobPayload = {
  'index.build': { attributeId: string };
  'index.drop': { attributeId: string };
  'attribute.purge': Record<string, never>;
  'automate.react': AutomationEvent;
};

const QUEUE_FOR: Record<JobName, QueueName> = {
  'index.build': QUEUES.system,
  'index.drop': QUEUES.system,
  'attribute.purge': QUEUES.system,
  'automate.react': QUEUES.automate,
};

export type JobDispatcher = {
  dispatch<N extends JobName>(
    name: N,
    payload: JobPayload[N],
  ): Promise<{ mode: 'queued' | 'inline' }>;
};

const log = createLogger({ name: 'nexus-web-jobs', level: 'info' });

/**
 * Inline fallback for `automate.react`: run stage 6 synchronously, in-process, with no platform
 * side effects wired up (no Redis means no worker, so `send_reply`/`send_email`/`enqueue_ai`
 * simply fail their one step — acceptable for a no-Redis developer machine, never production).
 */
async function runAutomateInline(runtime: TenantRuntime, event: AutomationEvent): Promise<void> {
  const { createAutomationRuntime, reactToEvent } = await import('@nexus/automation');
  const rt = createAutomationRuntime({
    runtime,
    enqueueEvent: (followUp) => runAutomateInline(runtime, followUp),
  });
  await reactToEvent(rt, event);
}

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
    case 'automate.react':
      await runAutomateInline(runtime, payload as AutomationEvent);
      return;
  }
}

const queuePromises = new Map<QueueName, Promise<Queue | null>>();

async function queueFor(name: QueueName): Promise<Queue | null> {
  let p = queuePromises.get(name);
  if (!p) {
    p = (async () => {
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
        return new Queue(name, {
          connection: redis,
          prefix: QUEUE_PREFIX,
          defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 3 },
        });
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), queue: name },
          'Redis unreachable — jobs will run inline in the web process',
        );
        return null;
      }
    })();
    queuePromises.set(name, p);
  }
  return p;
}

export function createDispatcher(runtime: TenantRuntime = defaultRuntime): JobDispatcher {
  return {
    async dispatch(name, payload) {
      const queue = await queueFor(QUEUE_FOR[name]);
      if (queue) {
        await queue.add(name, payload, {
          jobId: `${name}:${'attributeId' in payload ? payload.attributeId : Date.now()}`,
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
