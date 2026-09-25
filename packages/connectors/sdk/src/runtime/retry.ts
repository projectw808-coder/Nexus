/**
 * Retry policy (spec §9.2): exponential backoff with full jitter, max 6 attempts, then the
 * dead-letter queue. Never retry a 4xx that is not 408/429 — that rule lives in the failure
 * taxonomy (`NexusError.retryable`), this module only applies it.
 */
import { NexusError } from '@nexus/core';

export const MAX_ATTEMPTS = 6;

export type BackoffOptions = {
  baseMs?: number;
  capMs?: number;
  /** Injected for deterministic tests. */
  random?: () => number;
};

/** Full jitter: `random() * min(cap, base * 2^attempt)`, attempt counted from 0. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1_000;
  const cap = opts.capMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/**
 * Delay before the next attempt, honouring a platform-supplied resume time (`Retry-After`,
 * `resumesAt`) when it is later than the jittered backoff.
 */
export function nextDelayMs(
  attempt: number,
  error: unknown,
  opts: BackoffOptions & { now?: () => number } = {},
): number {
  const jittered = backoffDelayMs(attempt, opts);
  const resumesAt = error instanceof NexusError ? error.context.resumesAt : undefined;
  if (!resumesAt) return jittered;
  const wait = resumesAt.getTime() - (opts.now?.() ?? Date.now());
  return Math.max(jittered, wait);
}

/** Whether a failed attempt may be retried. Unknown (non-Nexus) errors are retried — they are bugs or transport faults, not policy. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NexusError) return error.retryable;
  return true;
}

export function shouldRetry(
  error: unknown,
  attemptsMade: number,
  maxAttempts = MAX_ATTEMPTS,
): boolean {
  return attemptsMade < maxAttempts && isRetryable(error);
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : 'aborted');
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.message === 'aborted');
}
