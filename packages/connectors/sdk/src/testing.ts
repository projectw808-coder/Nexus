/**
 * Test doubles for connector authors and the contract suite: a capturing logger, an in-memory
 * limiter and a `ConnCtx` factory. Importable as `@nexus/connector-sdk/testing`.
 */
import { MemoryBudgetStore } from './runtime/budget-store.ts';
import { createHttpClient, type FetchLike } from './runtime/http-client.ts';
import { RateLimiter, type SpendCap } from './runtime/rate-limiter.ts';
import type { ConnectorManifest } from './manifest.ts';
import type { Lane } from './quota.ts';
import { connectionSettingsSchema, type ConnectionSettingsInput } from './settings.ts';
import type { AuthCtx, ConnCtx, Logger, NormalizeCtx, TokenSet } from './spi.ts';

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
};

export function capturingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push = (level: LogEntry['level']) => (msg: string, fields?: Record<string, unknown>) => {
    entries.push(fields ? { level, msg, fields } : { level, msg });
  };
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function memoryLimiter(opts: { now?: () => number; random?: () => number } = {}): {
  limiter: RateLimiter;
  store: MemoryBudgetStore;
} {
  const store = new MemoryBudgetStore(opts.now);
  return {
    limiter: new RateLimiter({ store, now: opts.now, random: opts.random ?? (() => 0.5) }),
    store,
  };
}

export type TestConnCtxOptions<Cfg> = {
  manifest: ConnectorManifest;
  fetch: FetchLike;
  config: Cfg;
  token?: TokenSet;
  webhookSecret?: string | null;
  workspaceId?: string;
  connectionId?: string;
  accountExternalId?: string;
  settings?: ConnectionSettingsInput;
  lane?: Lane;
  spendCap?: SpendCap | null;
  logger?: Logger;
  signal?: AbortSignal;
  limiter?: RateLimiter;
  now?: () => number;
  /** In-call retry policy; tests use tiny delays. */
  retry?: { maxAttempts?: number; baseMs?: number; capMs?: number };
};

/** A fully wired `ConnCtx` against an injected fetch (the mock platform or a hand-written handler). */
export function createTestConnCtx<Cfg>(
  opts: TestConnCtxOptions<Cfg>,
): ConnCtx<Cfg> & { limiter: RateLimiter } {
  const workspaceId = opts.workspaceId ?? 'ws_test';
  const connectionId = opts.connectionId ?? 'conn_test';
  const logger = opts.logger ?? silentLogger;
  const limiter = opts.limiter ?? memoryLimiter({ now: opts.now }).limiter;
  const settings = connectionSettingsSchema.parse(opts.settings ?? {});
  const lane = opts.lane ?? 'delta';
  const token: TokenSet = opts.token ?? {
    accessToken: 'test-token',
    scopes: opts.manifest.scopes.map((s) => s.id),
    tokenType: 'Bearer',
    raw: {},
  };
  return {
    workspaceId,
    connectionId,
    platform: opts.manifest.platform,
    apiVersion: settings.apiVersion ?? opts.manifest.apiVersion,
    accountExternalId: opts.accountExternalId ?? 'acct_test',
    settings,
    config: opts.config,
    token: async () => token,
    webhookSecret: async () => opts.webhookSecret ?? null,
    budget: limiter.handle({
      connectionId,
      quota: opts.manifest.quota,
      lane,
      spendCap: opts.spendCap ?? settings.spendCap,
    }),
    http: createHttpClient({
      connectionId,
      fetch: opts.fetch,
      breaker: limiter.breaker,
      logger,
      retry: { baseMs: 1, capMs: 5, ...opts.retry },
      signal: opts.signal,
      now: opts.now,
    }),
    logger,
    signal: opts.signal ?? new AbortController().signal,
    lane,
    limiter,
  };
}

export function createTestAuthCtx<Cfg>(opts: {
  config: Cfg;
  fetch?: FetchLike;
  workspaceId?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  logger?: Logger;
}): AuthCtx<Cfg> {
  return {
    workspaceId: opts.workspaceId ?? 'ws_test',
    redirectUri: opts.redirectUri ?? 'http://localhost:3000/api/connect/callback',
    appCredentials: async () => ({
      clientId: opts.clientId ?? 'test-client',
      clientSecret: opts.clientSecret ?? 'test-secret',
    }),
    config: opts.config,
    http: createHttpClient({
      connectionId: `auth:${opts.workspaceId ?? 'ws_test'}`,
      fetch: opts.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      logger: opts.logger ?? silentLogger,
      retry: { baseMs: 1, capMs: 5 },
    }),
    logger: opts.logger ?? silentLogger,
    signal: new AbortController().signal,
  };
}

export function createTestNormalizeCtx(
  manifest: ConnectorManifest,
  overrides: Partial<NormalizeCtx> = {},
): NormalizeCtx {
  return {
    connectionId: 'conn_test',
    workspaceId: 'ws_test',
    platform: manifest.platform,
    accountExternalId: 'acct_test',
    apiVersion: manifest.apiVersion,
    fetchedAt: new Date('2026-09-24T00:00:00Z'),
    fieldMapping: {},
    ...overrides,
  };
}

/** Build a `Response` for hand-written fetch doubles. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
