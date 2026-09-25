/**
 * Everything the engine needs, injected once per process. Tests wire the mock platform's
 * fetch, an in-memory limiter and an inline bus; the worker wires Redis, BullMQ and real fetch.
 */
import type {
  AppCredentials,
  FetchLike,
  Logger,
  Platform,
  RateLimiter,
} from '@nexus/connector-sdk';
import type { TenantRuntime, Vault } from '@nexus/db';
import type { JobBus } from './bus.ts';
import type { ConnectorRegistry } from './registry.ts';
import type { CanonicalSink } from './sink.ts';

/** App-level secrets, resolved at call time and never stored on the deps object (§5.4). */
export type AppSecrets = {
  /** App-level webhook secret for platforms that sign with one (Meta's app secret); `null` when unknown. */
  webhookSecret(platform: Platform): string | null;
  /** The Nexus app registration on the platform. */
  oauthCredentials(platform: Platform): Promise<AppCredentials>;
  /** Signs the OAuth `state` (normally AUTH_SECRET). */
  stateSecret(): string;
};

export type SyncDeps = {
  runtime: TenantRuntime;
  vault: Vault;
  limiter: RateLimiter;
  registry: ConnectorRegistry;
  bus: JobBus;
  logger: Logger;
  sink: CanonicalSink;
  appSecrets: AppSecrets;
  /** Per-platform fetch (the in-process mock in tests). Defaults to global fetch. */
  fetchFor?: (platform: Platform) => FetchLike | undefined;
  now?: () => Date;
  /** Validate every normalized entity (dev/test) or a sample (prod). Default: all. */
  validateSample?: number;
  /** Public origin of the web app, for OAuth redirect URIs. */
  appUrl?: string;
  /** In-call HTTP retry policy (5xx/408/transport); tests shrink the delays. */
  httpRetry?: { maxAttempts?: number; baseMs?: number; capMs?: number };
};

export const nowOf = (deps: SyncDeps): Date => deps.now?.() ?? new Date();
