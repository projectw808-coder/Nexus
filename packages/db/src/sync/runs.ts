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

/**
 * Objects ingested per UTC day over the last N days (the grid card's sparkline, §12.2.C).
 * `SyncRun` is one row per resource poll — far lower cardinality than `ExternalObject` — so
 * bucketing in memory is cheap even for a busy connection; no rollup table needed.
 */
export async function dailyRunActivity(
  db: TenantDb,
  connectionId: string,
  days = 7,
): Promise<{ date: string; itemsFetched: number; runs: number; failed: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.syncRun.findMany({
    where: { connectionId, startedAt: { gte: since } },
    select: { startedAt: true, itemsFetched: true, status: true },
  });
  const buckets = new Map<string, { itemsFetched: number; runs: number; failed: number }>();
  for (const row of rows) {
    const day = row.startedAt.toISOString().slice(0, 10);
    const bucket = buckets.get(day) ?? { itemsFetched: 0, runs: 0, failed: 0 };
    bucket.itemsFetched += row.itemsFetched;
    bucket.runs += 1;
    if (row.status === 'FAILED') bucket.failed += 1;
    buckets.set(day, bucket);
  }
  const out: { date: string; itemsFetched: number; runs: number; failed: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, ...(buckets.get(date) ?? { itemsFetched: 0, runs: 0, failed: 0 }) });
  }
  return out;
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
