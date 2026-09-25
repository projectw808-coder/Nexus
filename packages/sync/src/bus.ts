/**
 * The job bus the engine enqueues into. Two implementations share one interface: BullMQ in
 * the worker (and in the web tier when Redis is reachable), and this inline bus for tests, the
 * CLI and the no-Redis developer mode (ADR-010). Both apply the §9.2 retry policy — exponential
 * backoff with full jitter, six attempts, then the dead-letter hook.
 */
import type { QueueName } from '@nexus/config';
import {
  MAX_ATTEMPTS,
  isAbortError,
  nextDelayMs,
  shouldRetry,
  sleep,
  type Lane,
  type Logger,
} from '@nexus/connector-sdk';

export type JobOptions = {
  /** Idempotent enqueue: a job with the same id that is pending or running is not added twice. */
  jobId?: string;
  lane?: Lane;
  delayMs?: number;
  attempts?: number;
};

export type JobEnvelope<T = unknown> = {
  queue: QueueName;
  name: string;
  data: T;
  opts?: JobOptions;
};

export type ActiveJob<T = unknown> = {
  id: string;
  queue: QueueName;
  name: string;
  data: T;
  attemptsMade: number;
  signal: AbortSignal;
};

export type JobHandler<T = unknown> = (job: ActiveJob<T>) => Promise<unknown>;

export interface JobBus {
  enqueue<T>(job: JobEnvelope<T>): Promise<{ jobId: string; mode: 'queued' | 'inline' }>;
}

export type DeadLetterHook = (job: ActiveJob, error: unknown) => Promise<void>;

export type InlineBusOptions = {
  handlers: Partial<Record<QueueName, JobHandler>>;
  onDeadLetter?: DeadLetterHook;
  logger?: Logger;
  retry?: { maxAttempts?: number; baseMs?: number; capMs?: number };
  /** Max concurrently running jobs (per process). */
  concurrency?: number;
};

let seq = 0;

/**
 * In-process bus. Jobs run on the next tick with the retry policy; `drain()` resolves when
 * nothing is pending or running — what tests and the CLI use to wait for the pipeline.
 */
export function createInlineBus(opts: InlineBusOptions) {
  const maxAttempts = opts.retry?.maxAttempts ?? MAX_ATTEMPTS;
  const concurrency = opts.concurrency ?? 4;
  const pending: { job: ActiveJob; notBefore: number }[] = [];
  const known = new Set<string>();
  const running = new Set<string>();
  const waiters: (() => void)[] = [];
  const controller = new AbortController();
  let stopped = false;
  let ticking = false;
  const stats = { completed: 0, failed: 0, retried: 0, deadLettered: 0 };

  const notify = () => {
    if (pending.length === 0 && running.size === 0) {
      for (const w of waiters.splice(0)) w();
    }
  };

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      let launched = false;
      for (let i = 0; i < pending.length && running.size < concurrency;) {
        const entry = pending[i]!;
        if (entry.notBefore > now) {
          i += 1;
          continue;
        }
        pending.splice(i, 1);
        launched = true;
        void run(entry.job);
      }
      if (!launched && pending.length && running.size < concurrency) {
        const next = Math.min(...pending.map((p) => p.notBefore));
        setTimeout(tick, Math.max(1, next - now)).unref?.();
      }
    } finally {
      ticking = false;
    }
  }

  async function run(job: ActiveJob): Promise<void> {
    running.add(job.id);
    const handler = opts.handlers[job.queue];
    try {
      if (!handler) throw new Error(`no handler registered for queue ${job.queue}`);
      await handler(job);
      stats.completed += 1;
      known.delete(job.id);
    } catch (error) {
      const attempts = job.attemptsMade + 1;
      if (!stopped && !isAbortError(error) && shouldRetry(error, attempts, maxAttempts)) {
        stats.retried += 1;
        const delay = nextDelayMs(attempts - 1, error, {
          baseMs: opts.retry?.baseMs ?? 1_000,
          capMs: opts.retry?.capMs ?? 60_000,
        });
        opts.logger?.warn('job failed, retrying', {
          queue: job.queue,
          name: job.name,
          jobId: job.id,
          attempt: attempts,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
        pending.push({ job: { ...job, attemptsMade: attempts }, notBefore: Date.now() + delay });
      } else {
        stats.failed += 1;
        known.delete(job.id);
        if (!isAbortError(error)) {
          stats.deadLettered += 1;
          opts.logger?.error('job dead-lettered', {
            queue: job.queue,
            name: job.name,
            jobId: job.id,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          try {
            await opts.onDeadLetter?.({ ...job, attemptsMade: attempts }, error);
          } catch (e) {
            opts.logger?.error('dead-letter hook failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    } finally {
      running.delete(job.id);
      notify();
      setTimeout(tick, 0).unref?.();
    }
  }

  const bus = {
    stats,
    get pendingCount() {
      return pending.length + running.size;
    },
    async enqueue<T>(job: JobEnvelope<T>) {
      const id = job.opts?.jobId ?? `inline-${++seq}`;
      if (known.has(id)) return { jobId: id, mode: 'inline' as const };
      known.add(id);
      pending.push({
        job: {
          id,
          queue: job.queue,
          name: job.name,
          data: job.data,
          attemptsMade: 0,
          signal: controller.signal,
        },
        notBefore: Date.now() + (job.opts?.delayMs ?? 0),
      });
      setTimeout(tick, 0).unref?.();
      return { jobId: id, mode: 'inline' as const };
    },
    /** Resolve once every queued and running job has finished (including retries). */
    drain(): Promise<void> {
      if (pending.length === 0 && running.size === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    /** Abort running jobs (their ctx.signal fires) and drop the queue — simulates a worker kill. */
    stop(): void {
      stopped = true;
      controller.abort(new Error('aborted'));
      pending.splice(0);
    },
    async sleep(ms: number) {
      await sleep(ms);
    },
  };
  return bus;
}

export type InlineBus = ReturnType<typeof createInlineBus>;
