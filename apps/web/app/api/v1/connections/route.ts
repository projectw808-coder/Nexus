/**
 * `GET /v1/connections` (§11.2). Token handles and webhook-secret handles are never projected
 * (§5.4) — `restConnection` is an allowlist, not a `delete`-the-secrets blocklist.
 */
import { pageQuerySchema } from '@nexus/api';
import { restRoute } from '../_lib/handler';
import { cappedLimit, decodeDateCursor, paginate, restConnection } from '../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute('READ', async (ctx) => {
  const q = ctx.query(pageQuerySchema);
  const take = cappedLimit(q.limit);
  const after = decodeDateCursor(q.cursor);
  const rows = await ctx.withTenant((db) =>
    db.connection.findMany({
      where: {
        deletedAt: null,
        ...(after
          ? {
              OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
    }),
  );
  const page = paginate(rows, take, (r) => r.createdAt);
  return { body: { items: page.items.map(restConnection), nextCursor: page.nextCursor } };
});
