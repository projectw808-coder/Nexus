/**
 * Hosts the `outbound.webhook` queue (§11.2, ADR-022 decision 4): one signed HTTP POST to a
 * customer's endpoint per `OutboundWebhookDelivery`.
 *
 * The retry schedule lives on the delivery row (`attempts` / `nextAttemptAt`, written by
 * `runOutboundWebhookDelivery` with the same `nextDelayMs` policy every other retry path uses), so
 * a non-2xx response does not fail the job — `deliverOutboundWebhookJob` re-enqueues it with the
 * computed delay instead. BullMQ's own retry (with `nexusBackoffStrategy`, same formula) stays for
 * unexpected faults: an unreadable vault entry, a delivery row that is not visible yet.
 *
 * A separate queue rather than sharing `outbound`: a customer endpoint that hangs for its full
 * timeout must not hold a slot that a human's reply to a DM is waiting for.
 */
import { QUEUE_PREFIX, QUEUES } from '@nexus/config';
import {
  deliverOutboundWebhookJob,
  resumeDueOutboundWebhookDeliveries,
  type SyncDeps,
} from '@nexus/sync';
import { runWithTraceCarrier, TRACE_CARRIER_KEY, type Logger } from '@nexus/telemetry';
import { Queue, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { nexusBackoffStrategy } from './bus.ts';

/**
 * The self-healing sweep: a worker killed between "record the failed attempt" and "re-enqueue"
 * would leave a delivery sitting in FAILED with a `nextAttemptAt` in the past. Re-enqueuing is
 * idempotent by job id, so running this on a timer is safe.
 */
export const OUTBOUND_WEBHOOK_SWEEP_JOB = 'outbound_webhook.sweep';
const SWEEP_EVERY_MS = 5 * 60_000;

export type OutboundWebhookHost = { worker: Worker; close(): Promise<void> };

export function startOutboundWebhookHost(opts: {
  redis: IORedis;
  log: Logger;
  syncDeps: SyncDeps;
}): OutboundWebhookHost {
  const worker = new Worker(
    QUEUES.outboundWebhook,
    async (job: Job<Record<string, unknown>>) =>
      runWithTraceCarrier(
        job.data[TRACE_CARRIER_KEY] as never,
        `${QUEUES.outboundWebhook}.${job.name}`,
        async () => {
          if (job.name === OUTBOUND_WEBHOOK_SWEEP_JOB)
            return resumeDueOutboundWebhookDeliveries(opts.syncDeps);
          const outcome = await deliverOutboundWebhookJob(opts.syncDeps, job.data);
          if (outcome.status === 'DEAD_LETTERED')
            opts.log.warn(
              { deliveryId: outcome.deliveryId, attempts: outcome.attempts, err: outcome.error },
              'outbound webhook delivery dead-lettered',
            );
          return outcome;
        },
        {
          'messaging.system': 'bullmq',
          'messaging.destination.name': QUEUES.outboundWebhook,
          'messaging.message.id': job.id ?? '',
          'nexus.job.attempt': job.attemptsMade + 1,
        },
      ),
    {
      connection: opts.redis,
      prefix: QUEUE_PREFIX,
      concurrency: 8,
      settings: { backoffStrategy: nexusBackoffStrategy },
    },
  );
  worker.on('failed', (job, error) => {
    opts.log.error({ jobId: job?.id, err: error }, 'outbound webhook job failed');
  });
  worker.on('error', (error) => opts.log.error({ err: error }, 'outbound webhook worker error'));

  const queue = new Queue(QUEUES.outboundWebhook, {
    connection: opts.redis,
    prefix: QUEUE_PREFIX,
  });
  void queue
    .upsertJobScheduler(
      OUTBOUND_WEBHOOK_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: OUTBOUND_WEBHOOK_SWEEP_JOB, data: {} },
    )
    .catch((e: unknown) => opts.log.warn({ err: e }, 'could not schedule the webhook sweep'));

  return {
    worker,
    async close() {
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}
