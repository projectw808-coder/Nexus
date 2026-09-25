/**
 * Wires `SyncDeps` from the validated environment: the vault's key provider, the limiter's
 * store (Redis when a client is supplied, memory otherwise — ADR-010), the registry with the
 * mock platform's origin, and the app-level secrets. Each host supplies its own bus and logger.
 */
import type { Env } from '@nexus/config';
import {
  MemoryBudgetStore,
  RateLimiter,
  RedisBudgetStore,
  localKeyProvider,
  type FetchLike,
  type KeyProvider,
  type Logger,
  type Platform,
  type RedisLike,
} from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import { createVault, runtime as defaultRuntime, type TenantRuntime } from '@nexus/db';
import type { JobBus } from './bus.ts';
import type { AppSecrets, SyncDeps } from './deps.ts';
import { createConnectorRegistry, type RegistryOptions } from './registry.ts';
import { countingSink, type CanonicalSink } from './sink.ts';
import { createAttributionSink } from './sinks/attribution.ts';
import { composeSinks, createConversationSink } from './sinks/conversations.ts';
import { createIdentitySink } from './sinks/identity.ts';
import { createTimelineSink } from './sinks/timeline.ts';

export function keyProviderFromEnv(
  env: Pick<Env, 'KMS_MASTER_KEY_ID' | 'ENCRYPTION_KEY_FALLBACK'>,
): KeyProvider {
  if (env.KMS_MASTER_KEY_ID.startsWith('local:')) {
    if (!env.ENCRYPTION_KEY_FALLBACK) {
      throw new NexusError('VALIDATION', {
        message: 'ENCRYPTION_KEY_FALLBACK is required when KMS_MASTER_KEY_ID is local:*',
      });
    }
    return localKeyProvider({
      masterKeyId: env.KMS_MASTER_KEY_ID,
      masterKeyBase64: env.ENCRYPTION_KEY_FALLBACK,
    });
  }
  // A cloud KMS provider registers here (ADR-014). Failing loudly beats a silent plaintext fallback.
  throw new NexusError('VALIDATION', {
    message: `no key provider for KMS_MASTER_KEY_ID=${env.KMS_MASTER_KEY_ID}`,
  });
}

export function appSecretsFromEnv(env: Env): AppSecrets {
  return {
    webhookSecret(platform: Platform) {
      switch (platform) {
        case 'MOCK':
          return env.MOCK_WEBHOOK_SECRET;
        case 'FACEBOOK':
        case 'INSTAGRAM':
          return env.META_APP_SECRET ?? null;
        case 'TIKTOK':
          return env.TIKTOK_WEBHOOK_SECRET ?? null;
        default:
          return null;
      }
    },
    async oauthCredentials(platform: Platform) {
      const pick = (id: string | undefined, secret: string | undefined) => {
        if (!id)
          throw new NexusError('VALIDATION', {
            message: `${platform} app credentials are not configured`,
          });
        return { clientId: id, clientSecret: secret };
      };
      switch (platform) {
        case 'MOCK':
          return pick(env.MOCK_CLIENT_ID, env.MOCK_CLIENT_SECRET);
        case 'FACEBOOK':
        case 'INSTAGRAM':
          return pick(env.META_APP_ID, env.META_APP_SECRET);
        case 'X':
          return pick(env.X_CLIENT_ID, env.X_CLIENT_SECRET);
        case 'LINKEDIN':
          return pick(env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET);
        case 'TIKTOK':
          return pick(env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET);
        case 'YOUTUBE':
        case 'GMAIL':
        case 'GOOGLE_CALENDAR':
        case 'GOOGLE_BUSINESS':
          return pick(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
        default:
          throw new NexusError('VALIDATION', {
            message: `${platform} does not use app credentials`,
          });
      }
    },
    stateSecret() {
      return env.AUTH_SECRET;
    },
  };
}

export type CreateDepsOptions = {
  env: Env;
  bus: JobBus;
  logger: Logger;
  redis?: RedisLike | null;
  runtime?: TenantRuntime;
  sink?: CanonicalSink;
  registry?: RegistryOptions;
  fetchFor?: (platform: Platform) => FetchLike | undefined;
};

export function createSyncDeps(opts: CreateDepsOptions): SyncDeps {
  const store = opts.redis ? new RedisBudgetStore(opts.redis) : new MemoryBudgetStore();
  return {
    runtime: opts.runtime ?? defaultRuntime,
    vault: createVault({ keyProvider: keyProviderFromEnv(opts.env) }),
    limiter: new RateLimiter({ store }),
    registry: createConnectorRegistry({
      mockBaseUrl: opts.env.MOCK_PLATFORM_URL,
      meta: {
        appId: opts.env.META_APP_ID,
        loginConfigId: opts.env.META_LOGIN_CONFIG_ID,
        graphOrigin: opts.env.META_GRAPH_ORIGIN,
      },
      ...opts.registry,
    }),
    bus: opts.bus,
    logger: opts.logger,
    sink:
      opts.sink ??
      composeSinks(
        countingSink(),
        createConversationSink(opts.runtime ?? defaultRuntime),
        createTimelineSink(opts.runtime ?? defaultRuntime),
        createIdentitySink(opts.runtime ?? defaultRuntime),
        createAttributionSink(opts.runtime ?? defaultRuntime),
      ),
    appSecrets: appSecretsFromEnv(opts.env),
    fetchFor: opts.fetchFor,
    appUrl: opts.env.APP_URL,
    validateSample: opts.env.NODE_ENV === 'production' ? 0.1 : 1,
  };
}

/** Adapts a pino-style logger (`log.info(obj, msg)`) to the SDK's `(msg, fields)` shape. */
export function sdkLoggerFrom(pino: {
  debug(o: object, m?: string): void;
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}): Logger {
  return {
    debug: (msg, fields) => pino.debug(fields ?? {}, msg),
    info: (msg, fields) => pino.info(fields ?? {}, msg),
    warn: (msg, fields) => pino.warn(fields ?? {}, msg),
    error: (msg, fields) => pino.error(fields ?? {}, msg),
  };
}
