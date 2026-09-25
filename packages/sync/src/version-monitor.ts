/**
 * The weekly Graph API version-drift monitor (spec §8.1): evaluates the pinned version's
 * sunset and, inside the 180-day window, opens ONE in-app task per workspace that has a Meta
 * connection (idempotent on a title marker), assigned to nobody, due at the sunset date.
 */
import { checkGraphVersion, metaManifest, type VersionCheck } from '@nexus/connector-meta';
import { listSchedulableConnections, systemActorFor } from '@nexus/db';
import type { SyncDeps } from './deps.ts';

export type VersionMonitorResult = VersionCheck & {
  feed: string;
  workspacesNotified: number;
  tasksOpened: number;
};

const MARKER = '[meta-version]';

export async function runMetaVersionMonitor(
  deps: SyncDeps,
  opts: { feedUrl?: string | null; now?: Date } = {},
): Promise<VersionMonitorResult> {
  const check = await checkGraphVersion({
    pinned: metaManifest.apiVersion,
    feedUrl: opts.feedUrl ?? null,
    now: opts.now,
  });
  const workspaces = new Set(
    (await listSchedulableConnections(deps.runtime))
      .filter((c) => c.platform === 'FACEBOOK' || c.platform === 'INSTAGRAM')
      .map((c) => c.workspaceId),
  );
  let tasksOpened = 0;
  if (
    check.action === 'plan_upgrade' ||
    check.action === 'urgent' ||
    check.action === 'unknown_version'
  ) {
    const title = `${MARKER} Upgrade the Meta Graph API from ${check.pinned}${check.latest !== check.pinned ? ` to ${check.latest}` : ''}`;
    for (const workspaceId of workspaces) {
      const actor = systemActorFor(workspaceId);
      const opened = await deps.runtime.withTenant(actor, async (db) => {
        const open = await db.task.findFirst({
          where: { title, status: { in: ['OPEN', 'IN_PROGRESS'] }, deletedAt: null },
          select: { id: true },
        });
        if (open) return false;
        await db.task.create({
          data: {
            workspaceId,
            title,
            description: `${check.summary}\n\nWhat to do: review Meta's changelog for the versions between ${check.pinned} and ${check.latest}, bump META_API_VERSION in the connector manifest, re-run the contract suite and golden fixtures, then deploy. Connections keep their pinned version until they are migrated.`,
            status: 'OPEN',
            priority: check.action === 'urgent' ? 'URGENT' : 'HIGH',
            dueAt: check.sunsetAt,
          },
        });
        return true;
      });
      if (opened) tasksOpened += 1;
    }
  }
  deps.logger.info('meta version monitor', {
    action: check.action,
    pinned: check.pinned,
    latest: check.latest,
    sunsetAt: check.sunsetAt?.toISOString() ?? null,
    feed: check.feed,
    workspaces: workspaces.size,
    tasksOpened,
  });
  return { ...check, workspacesNotified: workspaces.size, tasksOpened };
}
