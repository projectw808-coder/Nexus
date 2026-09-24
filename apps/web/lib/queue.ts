import { QUEUE_PREFIX, QUEUES } from '@nexus/config';
import { Queue, QueueEvents } from 'bullmq';
import { getRedis } from './redis.ts';

const g = globalThis as unknown as {
  __nexusSystemQueue?: Queue;
  __nexusSystemEvents?: QueueEvents;
};

/** Producer side of the `system` queue (housekeeping + the Phase 0 trace ping). */
export function getSystemQueue(): Queue {
  g.__nexusSystemQueue ??= new Queue(QUEUES.system, {
    connection: getRedis(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
  return g.__nexusSystemQueue;
}

export function getSystemQueueEvents(): QueueEvents {
  g.__nexusSystemEvents ??= new QueueEvents(QUEUES.system, {
    connection: getRedis().duplicate(),
    prefix: QUEUE_PREFIX,
  });
  return g.__nexusSystemEvents;
}
