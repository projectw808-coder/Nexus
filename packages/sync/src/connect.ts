/**
 * Connecting a platform (§7.1 auth → §7.4 connection): start the OAuth flow with a signed
 * state and a PKCE pair, finish it by exchanging the code, then discover the sub-accounts and
 * create one `Connection` per account — token and webhook secret in the vault, scopes
 * verified, webhooks subscribed, initial backfill queued, lifecycle audited (§5.4).
 */
import { randomBytes } from 'node:crypto';
import {
  PLATFORM_LABELS,
  createHttpClient,
  generatePkcePair,
  mintOauthState,
  verifyOauthState,
  type AuthCtx,
  type ConnCtx,
  type DiscoveredAccount,
  type Platform,
  type TokenSet,
} from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import { upsertConnection, writeAudit, type Actor } from '@nexus/db';
import type { SyncDeps } from './deps.ts';
import { enqueueBackfill } from './scheduler.ts';

export type OauthStart = { authorizeUrl: string; state: string; verifier: string; nonce: string };
export type OauthComplete = {
  platform: Platform;
  workspaceId: string;
  userId: string;
  returnTo: string;
  connectionId?: string;
  token: TokenSet;
};

export function buildAuthCtx(
  deps: SyncDeps,
  platform: Platform,
  workspaceId: string,
  connectionId?: string,
): AuthCtx<unknown> {
  const connector = deps.registry.get(platform);
  const base = (deps.appUrl ?? '').replace(/\/+$/, '');
  return {
    workspaceId,
    connectionId,
    redirectUri: `${base}/api/connect/${platform.toLowerCase()}/callback`,
    appCredentials: () => deps.appSecrets.oauthCredentials(platform),
    config: (connector as { config?: unknown }).config ?? {},
    http: createHttpClient({
      connectionId: `auth:${workspaceId}:${platform}`,
      fetch: deps.fetchFor?.(platform),
      breaker: deps.limiter.breaker,
      logger: deps.logger,
      retry: deps.httpRetry,
    }),
    logger: deps.logger,
    signal: new AbortController().signal,
  };
}

export function startOauth(
  deps: SyncDeps,
  input: {
    workspaceId: string;
    userId: string;
    platform: Platform;
    returnTo?: string;
    connectionId?: string;
    scopes?: string[];
  },
): OauthStart {
  const connector = deps.registry.get(input.platform);
  const nonce = randomBytes(12).toString('base64url');
  const state = mintOauthState(deps.appSecrets.stateSecret(), {
    workspaceId: input.workspaceId,
    platform: input.platform,
    userId: input.userId,
    returnTo: input.returnTo ?? '/',
    connectionId: input.connectionId,
    nonce,
  });
  const pkce = connector.manifest.authKind === 'oauth2_pkce' ? generatePkcePair() : undefined;
  const scopes = input.scopes ?? connector.manifest.scopes.map((s) => s.id);
  const authorizeUrl = connector.buildAuthUrl(
    buildAuthCtx(deps, input.platform, input.workspaceId, input.connectionId),
    { scopes, state, pkce },
  );
  return { authorizeUrl, state, verifier: pkce?.verifier ?? '', nonce };
}

export async function completeOauth(
  deps: SyncDeps,
  input: { code: string; state: string; verifier?: string },
): Promise<OauthComplete> {
  const payload = verifyOauthState(deps.appSecrets.stateSecret(), input.state);
  const platform = payload.platform as Platform;
  const connector = deps.registry.get(platform);
  const token = await connector.exchangeCode(
    buildAuthCtx(deps, platform, payload.workspaceId, payload.connectionId),
    input.code,
    input.verifier || undefined,
  );
  return {
    platform,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    returnTo: payload.returnTo,
    connectionId: payload.connectionId,
    token,
  };
}

/** A provisional context for discovery, before any Connection row exists. */
function provisionalCtx(
  deps: SyncDeps,
  platform: Platform,
  workspaceId: string,
  token: TokenSet,
  accountExternalId = 'me',
  webhookSecret: string | null = null,
): ConnCtx<unknown> {
  const connector = deps.registry.get(platform);
  const connectionId = `pending:${workspaceId}:${platform}`;
  return {
    workspaceId,
    connectionId,
    platform,
    apiVersion: connector.manifest.apiVersion,
    accountExternalId,
    settings: {
      resources: {},
      backfillDays: 90,
      overlapSeconds: 300,
      apiVersion: null,
      fieldMappingId: null,
      autoCreatePersonOnInbound: true,
      assignmentRuleId: null,
      slaTargetMinutes: null,
      businessHours: null,
      awayMessage: null,
      filters: { profanity: false, spam: false },
      retentionDays: null,
      rateLimitTier: null,
      dryRun: false,
      paused: false,
      spendCap: null,
      baseUrl: null,
      caCertPem: null,
      clientLimiter: null,
      subIdMapping: {},
      clickFilter: null,
    },
    config: (connector as { config?: unknown }).config ?? {},
    token: async () => token,
    webhookSecret: async () => webhookSecret,
    budget: deps.limiter.handle({
      connectionId,
      quota: connector.manifest.quota,
      lane: 'interactive',
    }),
    http: createHttpClient({
      connectionId,
      fetch: deps.fetchFor?.(platform),
      breaker: deps.limiter.breaker,
      logger: deps.logger,
      retry: deps.httpRetry,
    }),
    logger: deps.logger,
    signal: new AbortController().signal,
    lane: 'interactive',
  };
}

export type ConnectResult = {
  connections: { id: string; created: boolean; accountExternalId: string; label: string }[];
};

/**
 * Attach every discovered account (or the chosen subset) as a Connection. Idempotent per
 * (workspace, platform, account): reconnecting refreshes the token and scopes in place.
 */
export async function connectPlatform(
  deps: SyncDeps,
  input: {
    actor: Actor;
    platform: Platform;
    token: TokenSet;
    accountExternalIds?: string[];
    backfill?: boolean;
    maxPages?: number;
  },
): Promise<ConnectResult> {
  const { actor, platform } = input;
  if (!actor.userId)
    throw new NexusError('FORBIDDEN', { message: 'a user must perform the connection' });
  const connector = deps.registry.get(platform);
  const discovered = await connector.discoverAccounts(
    provisionalCtx(deps, platform, actor.workspaceId, input.token),
  );
  const chosen = input.accountExternalIds
    ? discovered.filter((a) => input.accountExternalIds!.includes(a.externalId))
    : discovered;
  if (chosen.length === 0)
    throw new NexusError('NOT_FOUND', {
      message: 'no accounts to connect',
      details: { discovered: discovered.length },
    });

  const out: ConnectResult = { connections: [] };
  for (const account of chosen) {
    const accountPlatform = account.platform;
    const accountToken = account.token ?? input.token;
    const scopeCheck = await connector.verifyScopes({
      ...provisionalCtx(deps, platform, actor.workspaceId, accountToken, account.externalId),
      platform: accountPlatform,
    });
    const webhookSecret = randomBytes(32).toString('base64url');
    const result = await deps.runtime.withTenant(actor, async (db) => {
      const tokenRef = (await deps.vault.putTokenSet(db, actor.workspaceId, accountToken)).ref;
      const webhookSecretRef = (
        await deps.vault.put(db, {
          workspaceId: actor.workspaceId,
          kind: 'WEBHOOK_SECRET',
          secret: webhookSecret,
        })
      ).ref;
      const conn = await upsertConnection(db, {
        workspaceId: actor.workspaceId,
        platform: accountPlatform,
        label: labelFor(PLATFORM_LABELS[accountPlatform], account),
        accountExternalId: account.externalId,
        accountName: account.name,
        accountAvatarUrl: account.avatarUrl,
        scopesGranted: accountToken.scopes,
        scopesRequired: connector.manifest.scopes.map((s) => s.id),
        capabilities: connector.manifest.capabilities.filter(
          (c) => !scopeCheck.degraded.includes(c),
        ),
        apiVersion: connector.manifest.apiVersion,
        tokenRef,
        tokenExpiresAt: accountToken.expiresAt ?? null,
        refreshableUntil: accountToken.refreshToken ? null : (accountToken.expiresAt ?? null),
        webhookSecretRef,
        ownerUserId: actor.userId,
      });
      if (scopeCheck.degraded.length) {
        await db.connection.update({
          where: { id: conn.id },
          data: { degradedCapabilities: scopeCheck.degraded, status: 'DEGRADED' },
        });
      }
      await writeAudit(db, actor, {
        action: conn.created ? 'connection.created' : 'connection.reconnected',
        targetType: 'Connection',
        targetId: conn.id,
        diff: {
          platform: accountPlatform,
          accountExternalId: account.externalId,
          scopes: accountToken.scopes,
          degraded: scopeCheck.degraded,
        },
      });
      return conn;
    });
    out.connections.push({
      id: result.id,
      created: result.created,
      accountExternalId: account.externalId,
      label: labelFor(PLATFORM_LABELS[accountPlatform], account),
    });

    // Best effort: a failed subscription never blocks the connection — the reconciliation poll covers it.
    if (connector.manifest.webhooks.supported) {
      try {
        const ctx = {
          ...provisionalCtx(
            deps,
            platform,
            actor.workspaceId,
            accountToken,
            account.externalId,
            webhookSecret,
          ),
          connectionId: result.id,
          platform: accountPlatform,
        };
        await connector.subscribeWebhooks(ctx, connector.manifest.webhooks.resources);
      } catch (e) {
        deps.logger.warn('webhook subscription failed; polling continues', {
          connectionId: result.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (input.backfill ?? true) {
      await enqueueBackfill(deps, {
        workspaceId: actor.workspaceId,
        connectionId: result.id,
        platform: accountPlatform,
        maxPages: input.maxPages,
      });
    }
  }
  return out;
}

function labelFor(displayName: string, account: DiscoveredAccount): string {
  return account.handle
    ? `${displayName} — ${account.name} (@${account.handle})`
    : `${displayName} — ${account.name}`;
}
