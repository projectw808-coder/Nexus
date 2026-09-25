/**
 * Turns a failure into the behaviour the §9.2 taxonomy prescribes and records it for the UI:
 * pause the connection, disable a capability, mark it degraded while the breaker is open… and
 * tells the caller whether the job should be retried.
 */
import { NexusError } from '@nexus/core';
import {
  recordIntegrationError,
  setConnectionStatus,
  systemActorFor,
  type ConnectionRow,
} from '@nexus/db';
import type { SyncDeps } from './deps.ts';

export type FailureOutcome = { error: NexusError; retry: boolean; behaviour: string };

export function asNexusError(e: unknown): NexusError {
  if (e instanceof NexusError) return e;
  return new NexusError('INTERNAL', {
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}

export async function applyFailure(
  deps: SyncDeps,
  input: {
    connection: ConnectionRow;
    error: unknown;
    syncRunId?: string | null;
    externalObjectId?: string | null;
  },
): Promise<FailureOutcome> {
  const error = asNexusError(input.error);
  const { connection } = input;
  const actor = systemActorFor(connection.workspaceId, connection.id);
  const behaviour = error.behaviour;

  await deps.runtime.withTenant(actor, async (db) => {
    await recordIntegrationError(db, {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      syncRunId: input.syncRunId ?? null,
      externalObjectId: input.externalObjectId ?? null,
      platform: connection.platform,
      error,
    });
    switch (behaviour) {
      case 'pause_connection':
        await setConnectionStatus(db, connection.id, 'RECONNECT_REQUIRED', {
          pausedReason: error.userMessage,
          healthScore: 0,
        });
        return;
      case 'disable_capability': {
        const cap = typeof error.context.capability === 'string' ? error.context.capability : null;
        const degraded = cap
          ? [...new Set([...connection.degradedCapabilities, cap])]
          : connection.degradedCapabilities;
        await setConnectionStatus(db, connection.id, 'DEGRADED', {
          degradedCapabilities: degraded,
          healthScore: Math.max(0, connection.healthScore - 20),
        });
        return;
      }
      case 'circuit_open':
      case 'backoff_requeue':
      case 'halt_until_reset':
        if (connection.status === 'CONNECTED') {
          await setConnectionStatus(db, connection.id, 'DEGRADED', {
            healthScore: Math.max(0, connection.healthScore - 10),
          });
        }
        return;
      default:
        return;
    }
  });

  return { error, retry: error.retryable, behaviour };
}
