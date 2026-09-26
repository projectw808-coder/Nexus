/**
 * Per-platform data retention (§5.5): `Connection.retentionDays` with a nightly purge.
 *
 * Shape follows `purgeDeletedAttributes` (src/objects/indexing.ts): one cross-tenant scan for
 * the work through `withSystem`, then the actual deletes per connection inside
 * `withTenant(systemActorFor(workspaceId, connectionId))` so RLS applies exactly as it would to
 * a request. One audit row per connection, carrying the counts — never one per deleted row.
 *
 * Hard delete, not `deletedAt`: a retention policy that leaves the content in the table has not
 * retained anything for a shorter time, it has only hidden it.
 */
import { writeAudit } from '../audit.ts';
import type { Platform } from '../generated/prisma/enums.ts';
import type { TenantRuntime } from '../scoped.ts';
import { systemActorFor } from '../sync/connections.ts';

/** Tables the purge touches, in delete order. */
export const RETENTION_TABLES = ['Message', 'TimelineEvent', 'ExternalObject'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

export type ConnectionPurge = {
  connectionId: string;
  workspaceId: string;
  platform: Platform;
  retentionDays: number;
  cutoff: Date;
  counts: Record<RetentionTable, number>;
  total: number;
};

export type RetentionPurgeResult = {
  /** Connections that had a `retentionDays` policy and were scanned. */
  scanned: number;
  /** Only the connections that actually had something to delete. */
  purged: ConnectionPurge[];
};

/**
 * Delete every connection-scoped row older than that connection's `retentionDays`.
 *
 * Connection-scoped means the row belongs to one platform account and disappears with it:
 * `ExternalObject` (the raw payload, by `fetchedAt`), `TimelineEvent` (by `occurredAt`) and
 * `Message` (by `sentAt`, reached through its `Conversation.connectionId`). `Conversation` itself
 * is deliberately left standing — it is a thread, not a dated artefact, and a thread whose old
 * messages aged out is still the thread someone is looking at in the inbox.
 */
export async function purgeConnectionRetention(
  runtime: TenantRuntime,
  now = new Date(),
): Promise<RetentionPurgeResult> {
  const due = await runtime.withSystem((s) =>
    s.connection.findMany({
      where: { retentionDays: { not: null }, deletedAt: null },
      select: { id: true, workspaceId: true, platform: true, retentionDays: true },
    }),
  );

  const purged: ConnectionPurge[] = [];
  for (const conn of due) {
    const retentionDays = conn.retentionDays ?? 0;
    if (retentionDays <= 0) continue; // 0/negative would mean "delete everything": never implicit.
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const actor = systemActorFor(conn.workspaceId, conn.id);

    const result = await runtime.withTenant(actor, async (db) => {
      const counts: Record<RetentionTable, number> = {
        Message: 0,
        TimelineEvent: 0,
        ExternalObject: 0,
      };
      counts.Message = (
        await db.message.deleteMany({
          where: { conversation: { connectionId: conn.id }, sentAt: { lt: cutoff } },
        })
      ).count;
      counts.TimelineEvent = (
        await db.timelineEvent.deleteMany({
          where: { connectionId: conn.id, occurredAt: { lt: cutoff } },
        })
      ).count;
      counts.ExternalObject = (
        await db.externalObject.deleteMany({
          where: { connectionId: conn.id, fetchedAt: { lt: cutoff } },
        })
      ).count;

      const total = counts.Message + counts.TimelineEvent + counts.ExternalObject;
      if (total > 0) {
        await writeAudit(db, actor, {
          action: 'retention.purged',
          targetType: 'Connection',
          targetId: conn.id,
          diff: { retentionDays, cutoff, counts, total },
        });
      }
      return { counts, total };
    });

    if (result.total > 0) {
      purged.push({
        connectionId: conn.id,
        workspaceId: conn.workspaceId,
        platform: conn.platform,
        retentionDays,
        cutoff,
        counts: result.counts,
        total: result.total,
      });
    }
  }

  return { scanned: due.length, purged };
}
