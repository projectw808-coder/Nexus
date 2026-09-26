/**
 * `GET /v1/conversations` (§11.2) — the unified inbox as a flat, cursor-paginated collection.
 *
 * The in-app inbox list (`conversation.list`) also returns tab counts, SLA buckets and assignee
 * filters that only make sense next to its own UI; REST exposes the collection and the three
 * filters an integration actually needs (status, platform, connection), keyed on
 * `(lastMessageAt, id)` — the same keyset the app pages on.
 */
import { conversationListQuerySchema } from '@nexus/api';
import { restRoute } from '../_lib/handler';
import { cappedLimit, decodeDateCursor, paginate, restConversation } from '../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute('READ', async (ctx) => {
  const q = ctx.query(conversationListQuerySchema);
  const take = cappedLimit(q.limit);
  const before = decodeDateCursor(q.cursor);
  const rows = await ctx.withTenant((db) =>
    db.conversation.findMany({
      where: {
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.platform ? { platform: q.platform as never } : {}),
        ...(q.connectionId ? { connectionId: q.connectionId } : {}),
        ...(before
          ? {
              OR: [
                { lastMessageAt: { lt: before.at } },
                { lastMessageAt: before.at, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    }),
  );
  const page = paginate(rows, take, (r) => r.lastMessageAt);
  return { body: { items: page.items.map(restConversation), nextCursor: page.nextCursor } };
});
