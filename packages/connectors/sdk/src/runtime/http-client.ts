/**
 * The `HttpClient` core injects into every `ConnCtx` — the only way a connector reaches a
 * platform. In one place: timeouts, retry of transport faults / 5xx / 408 with full jitter,
 * the circuit breaker, status classification into the §9.2 taxonomy, `Retry-After` parsing,
 * the served-API-version assertion and request logging without secrets.
 *
 * 429 is deliberately NOT retried here: it is a budget signal. The client records it on the
 * breaker, throws `RATE_LIMITED` with `resumesAt`, and the job-level policy re-queues.
 */
import { NexusError, classifyHttpStatus } from '@nexus/core';
import type { CircuitBreaker } from './circuit-breaker.ts';
import { backoffDelayMs, sleep } from './retry.ts';
import type { HttpClient, HttpRequest, HttpResponse, Logger } from '../spi.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpClientOptions = {
  connectionId: string;
  fetch?: FetchLike;
  breaker?: CircuitBreaker;
  logger?: Logger;
  retry?: { maxAttempts?: number; baseMs?: number; capMs?: number; random?: () => number };
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
  /** Header the platform echoes its API version in; compared with `pinned` to surface SCHEMA_DRIFT early. */
  servedVersion?: { header: string; pinned: string; onDrift?: (served: string) => void };
  /** Redacts header values before logging; defaults to dropping `authorization`. */
  now?: () => number;
};

export function endpointOf(req: HttpRequest): string {
  if (req.endpoint) return req.endpoint;
  try {
    return `${req.method} ${new URL(req.url).pathname}`;
  } catch {
    return `${req.method} ${req.url}`;
  }
}

export function parseRetryAfter(value: string | undefined, now: number): Date | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return new Date(now + Math.max(0, secs) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at);
}

function isBinary(b: unknown): b is Uint8Array {
  return b instanceof Uint8Array;
}

function encodeBody(req: HttpRequest): { body?: RequestInit['body']; contentType?: string } {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b === 'string') return { body: b };
  if (isBinary(b)) return { body: Buffer.from(b) };
  if (b instanceof URLSearchParams)
    return { body: b.toString(), contentType: 'application/x-www-form-urlencoded' };
  return { body: JSON.stringify(b), contentType: 'application/json' };
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const maxAttempts = opts.retry?.maxAttempts ?? 3;
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger;

  return {
    async request(req): Promise<HttpResponse> {
      const endpoint = endpointOf(req);
      if (opts.breaker) {
        const decision = await opts.breaker.check(opts.connectionId, endpoint);
        if (!decision.allow) {
          throw new NexusError('PLATFORM_DOWN', {
            message: `circuit open for ${endpoint}`,
            context: { resumesAt: decision.until },
            details: { endpoint, circuit: 'open', until: decision.until.toISOString() },
          });
        }
      }

      const url = new URL(req.url);
      for (const [k, v] of Object.entries(req.query ?? {}))
        if (v !== undefined) url.searchParams.set(k, String(v));
      const { body, contentType } = encodeBody(req);
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
        headers['content-type'] = contentType;
      const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs ?? 30_000;

      let attempt = 0;
      for (;;) {
        attempt += 1;
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = combineSignals([opts.signal, req.signal, timeout]);
        let res: Response;
        const startedAt = now();
        try {
          res = await fetchImpl(url.toString(), { method: req.method, headers, body, signal });
        } catch (cause) {
          if ((opts.signal?.aborted || req.signal?.aborted) && !timeout.aborted) throw cause; // caller cancelled
          const timedOut = timeout.aborted;
          await opts.breaker?.recordFailure(opts.connectionId, endpoint, timedOut ? 408 : null);
          log?.warn('platform request failed', {
            endpoint,
            attempt,
            timedOut,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          if (attempt < maxAttempts) {
            await sleep(backoffDelayMs(attempt - 1, opts.retry), opts.signal);
            continue;
          }
          throw new NexusError('PLATFORM_DOWN', {
            message: timedOut
              ? `${endpoint} timed out after ${timeoutMs} ms`
              : `${endpoint} unreachable`,
            details: { endpoint, attempts: attempt, timedOut },
            cause,
          });
        }

        const resHeaders = lowerHeaders(res.headers);
        const bodyText = await res.text();
        const durationMs = now() - startedAt;
        log?.debug('platform request', { endpoint, status: res.status, attempt, durationMs });

        if (opts.servedVersion) {
          const served = resHeaders[opts.servedVersion.header.toLowerCase()];
          if (served && served !== opts.servedVersion.pinned) opts.servedVersion.onDrift?.(served);
        }

        const status = res.status;
        if (status === 429) {
          await opts.breaker?.recordFailure(opts.connectionId, endpoint, 429);
          const retryAfter = parseRetryAfter(resHeaders['retry-after'], now());
          throw new NexusError('RATE_LIMITED', {
            message: `${endpoint} rate limited`,
            context: { resumesAt: retryAfter },
            details: {
              endpoint,
              status,
              retryAfter: retryAfter?.toISOString(),
              attempts: attempt,
              bodyText: bodyText.slice(0, 300),
            },
          });
        }
        if (status >= 500 || status === 408) {
          await opts.breaker?.recordFailure(opts.connectionId, endpoint, status);
          if (attempt < maxAttempts) {
            const retryAfter = parseRetryAfter(resHeaders['retry-after'], now());
            const wait = Math.max(
              backoffDelayMs(attempt - 1, opts.retry),
              retryAfter ? retryAfter.getTime() - now() : 0,
            );
            await sleep(wait, opts.signal);
            continue;
          }
          throw new NexusError('PLATFORM_DOWN', {
            message: `${endpoint} returned ${status} after ${attempt} attempts`,
            details: { endpoint, status, attempts: attempt, bodyText: bodyText.slice(0, 300) },
          });
        }
        if (status >= 400) {
          // Not a breaker event: the platform is up, our request was refused. No retry (§9.2).
          throw new NexusError(classifyHttpStatus(status), {
            message: `${endpoint} returned ${status}`,
            details: { endpoint, status, attempts: attempt, bodyText: bodyText.slice(0, 300) },
          });
        }
        await opts.breaker?.recordSuccess(opts.connectionId, endpoint);
        return {
          status,
          headers: resHeaders,
          bodyText,
          attempts: attempt,
          json() {
            return JSON.parse(bodyText) as unknown;
          },
        };
      }
    },
  };
}

/** Observed-usage extraction for the common header conventions; connectors extend per platform. */
export function observedFromHeaders(
  headers: Readonly<Record<string, string>>,
  now: number,
): {
  remaining?: number;
  limit?: number;
  resetsAt?: Date;
  retryAfter?: Date;
  headers: Record<string, string>;
} {
  const pick = (...names: string[]) => names.map((n) => headers[n]).find((v) => v !== undefined);
  const remaining = pick('x-rate-limit-remaining', 'x-ratelimit-remaining', 'ratelimit-remaining');
  const limit = pick('x-rate-limit-limit', 'x-ratelimit-limit', 'ratelimit-limit');
  const reset = pick('x-rate-limit-reset', 'x-ratelimit-reset', 'ratelimit-reset');
  let resetsAt: Date | undefined;
  if (reset !== undefined) {
    const n = Number(reset);
    if (Number.isFinite(n)) resetsAt = n > 1e9 ? new Date(n * 1000) : new Date(now + n * 1000);
  }
  const out: ReturnType<typeof observedFromHeaders> = { headers: {} };
  if (remaining !== undefined && Number.isFinite(Number(remaining)))
    out.remaining = Number(remaining);
  if (limit !== undefined && Number.isFinite(Number(limit))) out.limit = Number(limit);
  if (resetsAt) out.resetsAt = resetsAt;
  const ra = parseRetryAfter(headers['retry-after'], now);
  if (ra) out.retryAfter = ra;
  for (const k of [
    'x-rate-limit-remaining',
    'x-rate-limit-limit',
    'x-rate-limit-reset',
    'x-ratelimit-remaining',
    'x-ratelimit-limit',
    'x-ratelimit-reset',
    'retry-after',
    'x-app-usage',
    'x-business-use-case-usage',
  ]) {
    if (headers[k] !== undefined) out.headers[k] = headers[k]!;
  }
  return out;
}
