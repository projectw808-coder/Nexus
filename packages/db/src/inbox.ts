/**
 * Inbox housekeeping (spec §12.2.A): the SLA clock and snooze expiry. Both are plain data
 * rules on `Conversation`; the sink and the outbound flow call `slaDueFor`, the worker's
 * minute job calls `sweepSnoozed`.
 */
import { connectionSettingsSchema } from '@nexus/connector-sdk';
import { systemActorFor } from './sync/connections.ts';
import type { TenantDb, TenantRuntime } from './scoped.ts';
import { publishEvent } from './realtime.ts';
import { listWorkspaceIds } from './identity/workspaces.ts';

/** Workspace-wide default when a connection sets no SLA target of its own (ADR-018). */
export const DEFAULT_SLA_MINUTES = 60;

/** SLA target in minutes for a connection, or null when SLAs are switched off for it. */
export async function slaMinutesFor(db: TenantDb, connectionId: string): Promise<number | null> {
  const c = await db.connection.findFirst({
    where: { id: connectionId },
    select: { settings: true, workspace: { select: { settings: true } } },
  });
  if (!c) return null;
  const settings = connectionSettingsSchema.parse(c.settings ?? {});
  if (settings.slaTargetMinutes) return settings.slaTargetMinutes;
  const ws = (c.workspace.settings ?? {}) as { inbox?: { slaTargetMinutes?: number | null } };
  const v = ws.inbox?.slaTargetMinutes;
  if (v === null) return null;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_SLA_MINUTES;
}

/** Where the SLA clock lands for an inbound message that arrived at `at`. */
export function slaDueFor(at: Date, minutes: number | null): Date | null {
  return minutes ? new Date(at.getTime() + minutes * 60_000) : null;
}

/** Reopen every snoozed conversation whose snooze has expired, across all workspaces. */
export async function sweepSnoozed(
  runtime: TenantRuntime,
  opts: { now?: Date } = {},
): Promise<{ reopened: number }> {
  const now = opts.now ?? new Date();
  let reopened = 0;
  for (const workspaceId of await listWorkspaceIds(runtime)) {
    const actor = systemActorFor(workspaceId);
    reopened += await runtime.withTenant(actor, async (db) => {
      const due = await db.conversation.findMany({
        where: { status: 'SNOOZED', snoozedUntil: { lte: now }, deletedAt: null },
        select: { id: true },
        take: 1_000,
      });
      if (!due.length) return 0;
      const ids = due.map((d) => d.id);
      await db.conversation.updateMany({
        where: { id: { in: ids } },
        data: { status: 'OPEN', snoozedUntil: null },
      });
      await publishEvent(db, {
        workspaceId,
        topic: 'conversation.changed',
        payload: { ids, reason: 'unsnoozed' },
      });
      return ids.length;
    });
  }
  return { reopened };
}
