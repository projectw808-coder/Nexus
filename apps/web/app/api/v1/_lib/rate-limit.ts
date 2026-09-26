/**
 * Per-key rate limiting for REST v1 (§11.2) — a fixed 60-second window counted in this process.
 *
 * Deliberately not the connector `RateLimiter`/`MemoryBudgetStore` from @nexus/connector-sdk:
 * those model *platform* budgets, which must survive a restart and be shared across workers. An
 * API-key window is the opposite — it is cheap, per-process, and losing it on a restart only
 * ever makes us more generous for at most one minute. A module-level Map is the whole
 * implementation, and it is easier to reason about than reusing a store built for another job.
 */
export const WINDOW_MS = 60_000;
/** Applied when `ApiKey.rateLimitPerMinute` is null. */
export const DEFAULT_LIMIT_PER_MINUTE = 600;

type Window = { startedAt: number; count: number };

const windows = new Map<string, Window>();

export type RateVerdict = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds at which the current window resets — the value of `X-RateLimit-Reset`. */
  resetAt: number;
  retryAfterSeconds: number;
};

export function consume(
  apiKeyId: string,
  limitPerMinute: number | null,
  now = Date.now(),
): RateVerdict {
  const limit = limitPerMinute ?? DEFAULT_LIMIT_PER_MINUTE;
  const existing = windows.get(apiKeyId);
  const w =
    existing && now - existing.startedAt < WINDOW_MS ? existing : { startedAt: now, count: 0 };
  w.count += 1;
  windows.set(apiKeyId, w);
  const resetMs = w.startedAt + WINDOW_MS;
  return {
    allowed: w.count <= limit,
    limit,
    remaining: Math.max(0, limit - w.count),
    resetAt: Math.ceil(resetMs / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
  };
}

/** `X-RateLimit-*` go on **every** response, not only on a 429 (§11.2). */
export function rateLimitHeaders(v: RateVerdict): Record<string, string> {
  return {
    'x-ratelimit-limit': String(v.limit),
    'x-ratelimit-remaining': String(v.remaining),
    'x-ratelimit-reset': String(v.resetAt),
  };
}

/** Test seam: forget every window so one suite's requests cannot exhaust another's. */
export function resetRateLimits(): void {
  windows.clear();
}
