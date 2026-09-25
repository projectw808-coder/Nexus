/**
 * The cursor store (§9.1): one resumable position per (connection, resource). Saved in the
 * same transaction as the page it describes, so a worker killed mid-run resumes from the last
 * committed page and never re-fetches from zero.
 */
import type { TenantDb } from '../scoped.ts';

export type CursorState = {
  cursor: string | null;
  highWaterMark: Date | null;
  overlapSeconds: number;
};

export async function loadCursor(
  db: TenantDb,
  connectionId: string,
  resource: string,
): Promise<CursorState | null> {
  const row = await db.syncCursor.findFirst({ where: { connectionId, resource, deletedAt: null } });
  return row
    ? { cursor: row.cursor, highWaterMark: row.highWaterMark, overlapSeconds: row.overlapSeconds }
    : null;
}

export async function saveCursor(
  db: TenantDb,
  input: {
    workspaceId: string;
    connectionId: string;
    resource: string;
    cursor: string | null;
    highWaterMark?: Date | null;
    overlapSeconds?: number;
  },
): Promise<void> {
  const existing = await db.syncCursor.findFirst({
    where: { connectionId: input.connectionId, resource: input.resource },
    select: { id: true, highWaterMark: true },
  });
  const hwm =
    input.highWaterMark === undefined
      ? undefined
      : input.highWaterMark === null
        ? null
        : existing?.highWaterMark && existing.highWaterMark > input.highWaterMark
          ? existing.highWaterMark
          : input.highWaterMark;
  if (existing) {
    await db.syncCursor.update({
      where: { id: existing.id },
      data: {
        cursor: input.cursor,
        ...(hwm !== undefined ? { highWaterMark: hwm } : {}),
        ...(input.overlapSeconds !== undefined ? { overlapSeconds: input.overlapSeconds } : {}),
        deletedAt: null,
      },
    });
  } else {
    await db.syncCursor.create({
      data: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        resource: input.resource,
        cursor: input.cursor,
        highWaterMark: hwm ?? null,
        overlapSeconds: input.overlapSeconds ?? 300,
      },
    });
  }
}

/** Forget the in-progress page cursor (a completed backfill) but keep the high-water mark for deltas. */
export async function clearCursor(
  db: TenantDb,
  connectionId: string,
  resource: string,
): Promise<void> {
  await db.syncCursor.updateMany({ where: { connectionId, resource }, data: { cursor: null } });
}
