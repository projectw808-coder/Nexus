/**
 * `POST /v1/connections/{id}/sync` (§11.2) — the same `enqueueBackfill`/`enqueueDelta` the
 * "Sync now" button calls. Omitting `resource` syncs every resource the connector lists.
 */
import { syncRequestSchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { enqueueBackfill, enqueueDelta } from '@nexus/sync';
import { restRoute } from '../../../_lib/handler';

export const dynamic = 'force-dynamic';

export const POST = restRoute<{ id: string }>('WRITE', async (ctx, params) => {
  const input = ctx.parse(syncRequestSchema);
  const c = await ctx.withTenant(async (db) => {
    const row = await db.connection.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, workspaceId: true, platform: true },
    });
    if (!row) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
    return row;
  });

  const connector = ctx.deps.sync.registry.get(c.platform);
  const resources = input.resource ? [input.resource] : connector.listResources().map((r) => r.id);

  const jobIds: string[] = [];
  if (input.backfill) {
    jobIds.push(
      ...(await enqueueBackfill(ctx.deps.sync, {
        workspaceId: c.workspaceId,
        connectionId: c.id,
        platform: c.platform,
        resources,
      })),
    );
  } else {
    for (const resource of resources) {
      jobIds.push(
        await enqueueDelta(ctx.deps.sync, {
          workspaceId: c.workspaceId,
          connectionId: c.id,
          platform: c.platform,
          resource,
          trigger: 'MANUAL',
        }),
      );
    }
  }

  await ctx.withTenant((db) =>
    ctx.audit(db, {
      action: input.backfill ? 'connection.backfill_requested' : 'connection.sync_requested',
      targetType: 'Connection',
      targetId: c.id,
      diff: { resources, jobIds, via: 'rest_v1' },
    }),
  );
  return { status: 202, body: { jobIds } };
});
