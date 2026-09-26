/**
 * `GET /v1/connections/{id}/runs` (§11.2) — the run log, newest first, keyed on
 * `(startedAt, id)`.
 */
import { pageQuerySchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { restRoute } from '../../../_lib/handler';
import { cappedLimit, decodeDateCursor, paginate, restSyncRun } from '../../../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute<{ id: string }>('READ', async (ctx, params) => {
  const q = ctx.query(pageQuerySchema);
  const take = cappedLimit(q.limit);
  const before = decodeDateCursor(q.cursor);
  return ctx.withTenant(async (db) => {
    const c = await db.connection.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true },
    });
    if (!c) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
    const rows = await db.syncRun.findMany({
      where: {
        connectionId: c.id,
        ...(before
          ? {
              OR: [
                { startedAt: { lt: before.at } },
                { startedAt: before.at, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const page = paginate(rows, take, (r) => r.startedAt);
    return { body: { items: page.items.map(restSyncRun), nextCursor: page.nextCursor } };
  });
});
