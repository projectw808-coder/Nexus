/**
 * The token sweep (§5.4): refresh at 70% of remaining lifetime; a token within seven days of
 * expiry with no refresh path raises RECONNECT_REQUIRED, notifies the owner and pauses only
 * that connection. Runs hourly from the worker; also callable from the CLI.
 */
import { tokenLifecycle, type Logger } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import { listConnectionsForTokenSweep, setConnectionStatus, systemActorFor } from '@nexus/db';
import { bindConnection } from './context.ts';
import { nowOf, type SyncDeps } from './deps.ts';
import { applyFailure } from './failures.ts';

export type Notifier = {
  reconnectRequired(input: {
    workspaceId: string;
    connectionId: string;
    label: string;
    ownerUserId: string | null;
    expiresAt: Date | null;
    reason: string;
  }): Promise<void>;
};

/** Default notifier: a structured log line. The web tier supplies the e-mailing one (Phase 9 health console). */
export function loggingNotifier(log: Logger): Notifier {
  return {
    async reconnectRequired(input) {
      log.warn('connection requires reconnect', { ...input });
    },
  };
}

export type SweepResult = {
  checked: number;
  refreshed: number;
  reconnectRequired: number;
  failed: number;
};

export async function sweepTokens(
  deps: SyncDeps,
  opts: { notifier?: Notifier; horizonDays?: number } = {},
): Promise<SweepResult> {
  const now = nowOf(deps);
  const notifier = opts.notifier ?? loggingNotifier(deps.logger);
  const horizon = new Date(now.getTime() + (opts.horizonDays ?? 30) * 86_400_000);
  const result: SweepResult = { checked: 0, refreshed: 0, reconnectRequired: 0, failed: 0 };

  for (const c of await listConnectionsForTokenSweep(deps.runtime, horizon)) {
    result.checked += 1;
    const actor = systemActorFor(c.workspaceId, c.id);
    try {
      const { token, rotatedAt } = await deps.runtime.withTenant(actor, (db) =>
        deps.vault.getTokenSet(db, c.tokenRef),
      );
      const life = tokenLifecycle(token, { issuedAt: rotatedAt, now });
      if (life.state === 'fresh' || life.state === 'no_expiry') continue;
      if (life.state === 'refresh_due') {
        const bound = await bindConnection(deps, {
          workspaceId: c.workspaceId,
          connectionId: c.id,
          lane: 'interactive',
        });
        const authCtx = {
          workspaceId: c.workspaceId,
          connectionId: c.id,
          redirectUri: `${deps.appUrl ?? ''}/api/connect/${c.platform.toLowerCase()}/callback`,
          appCredentials: () => deps.appSecrets.oauthCredentials(c.platform),
          config: bound.ctx.config,
          http: bound.ctx.http,
          logger: bound.log,
          signal: bound.ctx.signal,
        };
        const next = await bound.connector.refresh(authCtx, token);
        await deps.runtime.withTenant(actor, async (db) => {
          await deps.vault.rotateTokenSet(db, c.tokenRef, next);
          await db.connection.update({
            where: { id: c.id },
            data: { tokenExpiresAt: next.expiresAt ?? null },
          });
        });
        result.refreshed += 1;
        continue;
      }
      // reconnect_soon or expired without a refresh path
      const reason =
        life.state === 'expired'
          ? 'The access token has expired and cannot be refreshed.'
          : 'The access token expires within 7 days and cannot be refreshed.';
      await deps.runtime.withTenant(actor, (db) =>
        setConnectionStatus(db, c.id, 'RECONNECT_REQUIRED', {
          pausedReason: reason,
          healthScore: 0,
        }),
      );
      await notifier.reconnectRequired({
        workspaceId: c.workspaceId,
        connectionId: c.id,
        label: c.label,
        ownerUserId: c.ownerUserId,
        expiresAt: life.expiresAt,
        reason,
      });
      result.reconnectRequired += 1;
    } catch (e) {
      result.failed += 1;
      const err =
        e instanceof NexusError
          ? e
          : new NexusError('INTERNAL', {
              message: e instanceof Error ? e.message : String(e),
              cause: e,
            });
      const connection = await deps.runtime.withTenant(actor, (db) =>
        db.connection.findUnique({ where: { id: c.id } }),
      );
      if (connection) {
        const outcome = await applyFailure(deps, {
          connection: { ...connection, settings: bindSettings(connection.settings) },
          error: err,
        });
        if (outcome.behaviour === 'pause_connection') {
          result.reconnectRequired += 1;
          await notifier.reconnectRequired({
            workspaceId: c.workspaceId,
            connectionId: c.id,
            label: c.label,
            ownerUserId: c.ownerUserId,
            expiresAt: c.tokenExpiresAt,
            reason: err.userMessage,
          });
        }
      }
    }
  }
  return result;
}

import { connectionSettingsSchema } from '@nexus/connector-sdk';
function bindSettings(raw: unknown) {
  return connectionSettingsSchema.parse(raw ?? {});
}
