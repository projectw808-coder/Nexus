/**
 * Builds the `ConnCtx` a connector receives for one unit of work: lazily-resolved token from
 * the vault, the lane's budget handle, an HTTP client with the connection's breaker, and a
 * logger that carries the correlation fields. Nothing here is cached across jobs — tokens can
 * rotate between two pages of the same run.
 */
import {
  createHttpClient,
  type ConnCtx,
  type Connector,
  type Lane,
  type Logger,
  type TokenSet,
} from '@nexus/connector-sdk';
import { getConnection, systemActorFor, type ConnectionRow } from '@nexus/db';
import { NexusError } from '@nexus/core';
import type { SyncDeps } from './deps.ts';

export type Bound = {
  connection: ConnectionRow;
  connector: Connector<unknown>;
  ctx: ConnCtx<unknown>;
  log: Logger;
};

function childLogger(base: Logger, fields: Record<string, unknown>): Logger {
  const wrap =
    (fn: (msg: string, f?: Record<string, unknown>) => void) =>
    (msg: string, f?: Record<string, unknown>) =>
      fn(msg, { ...fields, ...f });
  return {
    debug: wrap(base.debug.bind(base)),
    info: wrap(base.info.bind(base)),
    warn: wrap(base.warn.bind(base)),
    error: wrap(base.error.bind(base)),
  };
}

export async function loadConnection(
  deps: SyncDeps,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const row = await deps.runtime.withTenant(systemActorFor(workspaceId, connectionId), (db) =>
    getConnection(db, connectionId),
  );
  if (!row)
    throw new NexusError('NOT_FOUND', {
      message: `connection ${connectionId} not found`,
      details: { connectionId },
    });
  return row;
}

export async function bindConnection(
  deps: SyncDeps,
  input: {
    workspaceId: string;
    connectionId: string;
    lane: Lane;
    signal?: AbortSignal;
    connection?: ConnectionRow;
  },
): Promise<Bound> {
  const connection =
    input.connection ?? (await loadConnection(deps, input.workspaceId, input.connectionId));
  const connector = deps.registry.get(connection.platform);
  const actor = systemActorFor(connection.workspaceId, connection.id);
  const log = childLogger(deps.logger, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    platform: connection.platform,
    lane: input.lane,
  });
  const signal = input.signal ?? new AbortController().signal;
  const apiVersion = connection.settings.apiVersion ?? connection.apiVersion;

  let cached: TokenSet | null = null;
  const token = async (): Promise<TokenSet> => {
    if (cached) return cached;
    const { token: t } = await deps.runtime.withTenant(actor, (db) =>
      deps.vault.getTokenSet(db, connection.tokenRef),
    );
    cached = t;
    return t;
  };

  const http = createHttpClient({
    connectionId: connection.id,
    fetch: deps.fetchFor?.(connection.platform),
    breaker: deps.limiter.breaker,
    logger: log,
    retry: deps.httpRetry,
    signal,
    now: deps.now ? () => deps.now!().getTime() : undefined,
    servedVersion:
      connector.manifest.apiVersionHeader === undefined
        ? undefined
        : {
            header: connector.manifest.apiVersionHeader,
            pinned: apiVersion,
            onDrift: (served) =>
              log.warn('platform serves a different API version than pinned', {
                served,
                pinned: apiVersion,
              }),
          },
  });

  const ctx: ConnCtx<unknown> = {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    platform: connection.platform,
    apiVersion,
    accountExternalId: connection.accountExternalId,
    settings: connection.settings,
    config: (connector as { config?: unknown }).config ?? {},
    token,
    webhookSecret: async () => {
      if (!connection.webhookSecretRef) return null;
      const r = await deps.runtime.withTenant(actor, (db) =>
        deps.vault.get(db, connection.webhookSecretRef!),
      );
      return r.secret;
    },
    budget: deps.limiter.handle({
      connectionId: connection.id,
      quota: connector.manifest.quota,
      lane: input.lane,
      spendCap: connection.settings.spendCap,
    }),
    http,
    logger: log,
    signal,
    lane: input.lane,
  };
  return { connection, connector, ctx, log };
}
