/**
 * `GET /v1/search?q=` (§11.2) — cross-object search, the `search.global` procedure's query
 * (FTS + trigram per object type through `queryRecords`), grouped by object type.
 */
import { searchQuerySchema } from '@nexus/api';
import { queryRecords } from '@nexus/db';
import { attributesFor } from '@/server/objects-helpers';
import { restRoute } from '../_lib/handler';
import { restRecord } from '../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute('READ', async (ctx) => {
  const { q, limitPerObject } = ctx.query(searchQuerySchema);
  return ctx.withTenant(async (db, actor) => {
    const types = await db.objectType.findMany({
      where: { deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    const groups = [];
    for (const ot of types) {
      const attrs = await attributesFor(db, ot.id);
      const result = await queryRecords(db, {
        workspaceId: actor.workspaceId,
        objectTypeId: ot.id,
        attributes: attrs,
        query: {
          filters: [],
          sort: [],
          search: q,
          limit: limitPerObject,
          includeDeleted: false,
        },
      });
      if (result.items.length === 0) continue;
      groups.push({
        objectType: {
          id: ot.id,
          apiSlug: ot.apiSlug,
          singular: ot.singular,
          plural: ot.plural,
        },
        items: result.items.map((r) => restRecord(actor, attrs, r)),
        more: result.nextCursor !== null,
      });
    }
    return { body: { q, groups } };
  });
});
