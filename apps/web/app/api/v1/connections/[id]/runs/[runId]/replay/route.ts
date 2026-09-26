/**
 * `POST /v1/connections/{id}/runs/{runId}/replay` (§11.2).
 *
 * Replay is `replayConnection` from @nexus/sync — the same function the dead-letter and
 * webhook-delivery replays in the integrations hub go through (§4.1: stages 3–7 are replayable
 * per object and per connection, and the raw store is never touched).
 *
 * Scope note, because the wire path implies more precision than the store can give: a
 * `SyncRun` records what a run *did*, not which `ExternalObject` rows it wrote, and the raw
 * store keys on `fetchedAt`, not on a run id. The replay therefore covers this connection's raw
 * objects fetched from the run's `startedAt` onwards. Replaying is idempotent by construction
 * (§9.1) — the raw store collapses a duplicate — so a wider window costs work, never
 * correctness.
 */
import { replayRequestSchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { replayConnection } from '@nexus/sync';
import { restRoute } from '../../../../../_lib/handler';

export const dynamic = 'force-dynamic';

type Params = { id: string; runId: string };

export const POST = restRoute<Params>('WRITE', async (ctx, params) => {
  const input = ctx.parse(replayRequestSchema);
  const run = await ctx.withTenant(async (db) => {
    const row = await db.syncRun.findFirst({
      where: { id: params.runId, connectionId: params.id },
      select: { id: true, resource: true, startedAt: true, status: true },
    });
    if (!row) throw new NexusError('NOT_FOUND', { message: 'Sync run not found.' });
    if (row.status === 'QUEUED' || row.status === 'RUNNING') {
      throw new NexusError('CONFLICT', {
        context: { reason: 'That run has not finished yet; there is nothing to replay.' },
      });
    }
    return row;
  });

  const result = await replayConnection(ctx.deps.sync, {
    workspaceId: ctx.workspaceId,
    connectionId: params.id,
    fromStage: input.fromStage,
    since: run.startedAt,
  });

  await ctx.withTenant((db) =>
    ctx.audit(db, {
      action: 'sync_run.replayed',
      targetType: 'SyncRun',
      targetId: run.id,
      diff: { ...result, fromStage: input.fromStage, via: 'rest_v1' },
    }),
  );

  return {
    status: 202,
    body: { runId: run.id, resource: run.resource, objects: result.objects, jobs: result.jobs },
  };
});
