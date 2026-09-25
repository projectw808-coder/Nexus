/**
 * `SyncRun` bookkeeping: one row per execution with live counters, so the UI can show progress
 * and an ETA while a backfill runs and the health console can list what failed and why.
 */
import type { NexusError } from '@nexus/core';
import type { RunStatus, SyncTrigger } from '../generated/prisma/enums.ts';
import type { TenantDb } from '../scoped.ts';

export async function startRun(
  db: TenantDb,
  input: { workspaceId: string; connectionId: string; resource: string; trigger: SyncTrigger },
): Promise<{ id: string }> {
  return db.syncRun.create({
    data: { ...input, status: 'RUNNING', startedAt: new Date() },
    select: { id: true },
  });
}

export async function progressRun(
  db: TenantDb,
  id: string,
  delta: {
    fetched?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    budgetSpent?: number;
  },
): Promise<void> {
  await db.syncRun.update({
    where: { id },
    data: {
      itemsFetched: { increment: delta.fetched ?? 0 },
      itemsCreated: { increment: delta.created ?? 0 },
      itemsUpdated: { increment: delta.updated ?? 0 },
      itemsSkipped: { increment: delta.skipped ?? 0 },
      budgetSpent: { increment: Math.round(delta.budgetSpent ?? 0) },
    },
  });
}

export async function finishRun(
  db: TenantDb,
  id: string,
  outcome: {
    status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
    error?: NexusError | null;
  },
): Promise<void> {
  await db.syncRun.update({
    where: { id },
    data: {
      status: outcome.status,
      finishedAt: new Date(),
      errorCode: outcome.error?.code ?? null,
      errorMessage: outcome.error ? outcome.error.userMessage : null,
      remediation: outcome.error ? outcome.error.remediation : null,
    },
  });
}

/** Runs a previous worker left RUNNING — marked cancelled at startup so the UI does not show ghosts. */
export async function cancelStaleRuns(
  db: TenantDb,
  connectionId: string,
  olderThan: Date,
): Promise<number> {
  const r = await db.syncRun.updateMany({
    where: { connectionId, status: 'RUNNING', startedAt: { lt: olderThan } },
    data: {
      status: 'CANCELLED',
      finishedAt: new Date(),
      errorCode: 'INTERNAL',
      errorMessage: 'The worker restarted while this run was in progress; it resumed in a new run.',
    },
  });
  return r.count;
}
