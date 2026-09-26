/**
 * Workspace-wide health console queries (§12.2.C). Reconciliation/drift sampling (§9.1) has no
 * writer yet — `ConnectionDriftSample` stays queryable here for when it does, but callers must
 * treat an empty result as "not measured," never as "confirmed zero drift."
 */
import type { TenantDb } from '../scoped.ts';

export async function expiringTokens(db: TenantDb, withinDays: number) {
  const horizon = new Date(Date.now() + withinDays * 86_400_000);
  return db.connection.findMany({
    where: {
      deletedAt: null,
      tokenExpiresAt: { not: null, lte: horizon },
      status: { notIn: ['REVOKED'] },
    },
    orderBy: { tokenExpiresAt: 'asc' },
    select: {
      id: true,
      label: true,
      platform: true,
      status: true,
      tokenExpiresAt: true,
      ownerUserId: true,
    },
  });
}

export async function recentFailedRuns(db: TenantDb, opts: { since: Date; limit?: number }) {
  return db.syncRun.findMany({
    where: { status: 'FAILED', startedAt: { gte: opts.since } },
    orderBy: { startedAt: 'desc' },
    take: opts.limit ?? 50,
    include: { connection: { select: { label: true, platform: true } } },
  });
}

export async function recentDriftSamples(db: TenantDb, opts: { since: Date; limit?: number }) {
  return db.connectionDriftSample.findMany({
    where: { sampledAt: { gte: opts.since } },
    orderBy: { sampledAt: 'desc' },
    take: opts.limit ?? 50,
    include: { connection: { select: { label: true, platform: true } } },
  });
}
