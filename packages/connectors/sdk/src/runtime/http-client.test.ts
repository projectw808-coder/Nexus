import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { MemoryBudgetStore } from './budget-store.ts';
import { CircuitBreaker } from './circuit-breaker.ts';
import { createHttpClient, observedFromHeaders, parseRetryAfter } from './http-client.ts';

function scripted(responses: (() => Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    const r = next();
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

describe('http client', () => {
  it('retries 5xx with backoff, then succeeds, and reports attempts', async () => {
    const s = scripted([json(503, {}), json(500, {}), json(200, { ok: 1 })]);
    const http = createHttpClient({
      connectionId: 'c',
      fetch: s.fetch,
      retry: { baseMs: 1, capMs: 2 },
    });
    const res = await http.request({
      method: 'GET',
      url: 'https://api.test/things',
      query: { page: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(res.json()).toEqual({ ok: 1 });
    expect(s.calls[0]!.url).toBe('https://api.test/things?page=2');
  });

  it('gives up after maxAttempts with PLATFORM_DOWN', async () => {
    const s = scripted([json(500, {}), json(500, {}), json(500, {})]);
    const http = createHttpClient({
      connectionId: 'c',
      fetch: s.fetch,
      retry: { maxAttempts: 3, baseMs: 1, capMs: 2 },
    });
    await expect(http.request({ method: 'GET', url: 'https://api.test/x' })).rejects.toMatchObject({
      code: 'PLATFORM_DOWN',
      details: { attempts: 3 },
    });
  });

  it('does not retry a 429 but surfaces Retry-After as resumesAt', async () => {
    const s = scripted([json(429, {}, { 'retry-after': '30' })]);
    const http = createHttpClient({ connectionId: 'c', fetch: s.fetch, now: () => 1_000_000 });
    const e = await http
      .request({ method: 'GET', url: 'https://api.test/x' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NexusError);
    expect((e as NexusError).code).toBe('RATE_LIMITED');
    expect((e as NexusError).context.resumesAt?.getTime()).toBe(1_030_000);
    expect(s.calls).toHaveLength(1);
  });

  it('never retries a plain 4xx and classifies it', async () => {
    const s = scripted([json(401, { error: 'bad token' })]);
    const http = createHttpClient({ connectionId: 'c', fetch: s.fetch });
    await expect(http.request({ method: 'GET', url: 'https://api.test/x' })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    expect(s.calls).toHaveLength(1);
    const s2 = scripted([json(403, {})]);
    await expect(
      createHttpClient({ connectionId: 'c', fetch: s2.fetch }).request({
        method: 'GET',
        url: 'https://api.test/x',
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('opens the circuit after repeated 5xx and short-circuits later calls', async () => {
    let t = 0;
    const store = new MemoryBudgetStore(() => t);
    const breaker = new CircuitBreaker(store, {
      now: () => t,
      random: () => 0.5,
      baseOpenMs: 10_000,
    });
    const s = scripted(Array.from({ length: 6 }, () => json(502, {})));
    const http = createHttpClient({
      connectionId: 'c',
      fetch: s.fetch,
      breaker,
      retry: { maxAttempts: 6, baseMs: 1, capMs: 1 },
      now: () => t,
    });
    await expect(http.request({ method: 'GET', url: 'https://api.test/x' })).rejects.toMatchObject({
      code: 'PLATFORM_DOWN',
    });
    const e = await http.request({ method: 'GET', url: 'https://api.test/x' }).then(
      () => {
        throw new Error('expected the circuit to be open');
      },
      (x: unknown) => x as NexusError,
    );
    expect(e.details.circuit).toBe('open');
    expect(s.calls.length).toBeLessThanOrEqual(6);
    t += 10_000;
    const s2 = scripted([json(200, { ok: true })]);
    const http2 = createHttpClient({ connectionId: 'c', fetch: s2.fetch, breaker, now: () => t });
    expect((await http2.request({ method: 'GET', url: 'https://api.test/x' })).status).toBe(200);
    expect((await breaker.state('c', 'GET /x')).state).toBe('closed');
  });

  it('JSON-encodes object bodies, passes strings verbatim and honours the served-version hook', async () => {
    const drift: string[] = [];
    const s = scripted([json(200, {}, { 'x-api-version': 'v27.0' }), json(200, {})]);
    const http = createHttpClient({
      connectionId: 'c',
      fetch: s.fetch,
      servedVersion: { header: 'x-api-version', pinned: 'v26.0', onDrift: (v) => drift.push(v) },
    });
    await http.request({ method: 'POST', url: 'https://api.test/x', body: { a: 1 } });
    await http.request({
      method: 'POST',
      url: 'https://api.test/x',
      body: 'raw=1',
      headers: { 'content-type': 'text/plain' },
    });
    expect(s.calls[0]!.init.body).toBe('{"a":1}');
    expect((s.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(s.calls[1]!.init.body).toBe('raw=1');
    expect(drift).toEqual(['v27.0']);
  });

  it('retries transport faults and treats a timeout as 408 for the breaker', async () => {
    const s = scripted([() => new Error('ECONNRESET'), json(200, { ok: true })]);
    const http = createHttpClient({
      connectionId: 'c',
      fetch: s.fetch,
      retry: { baseMs: 1, capMs: 1 },
    });
    expect((await http.request({ method: 'GET', url: 'https://api.test/x' })).attempts).toBe(2);
  });
});

describe('header helpers', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('120', 1000)!.getTime()).toBe(121_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', 0)!.toISOString()).toBe(
      '2026-10-21T07:28:00.000Z',
    );
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
  });
  it('extracts standard rate-limit headers', () => {
    const o = observedFromHeaders(
      {
        'x-rate-limit-remaining': '12',
        'x-rate-limit-limit': '15',
        'x-rate-limit-reset': '1800000000',
        'retry-after': '5',
      },
      1_000_000,
    );
    expect(o.remaining).toBe(12);
    expect(o.limit).toBe(15);
    expect(o.resetsAt!.getTime()).toBe(1_800_000_000_000);
    expect(o.retryAfter!.getTime()).toBe(1_005_000);
    expect(Object.keys(o.headers)).toHaveLength(4);
  });
});
