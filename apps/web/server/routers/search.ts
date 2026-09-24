import { queryRecords } from '@nexus/db';
import { z } from 'zod';
import { attributesFor, publicRecord, recordLabel } from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

/** Cross-object search (§11.1 `search`): FTS + trigram per object type, interface-isolated. */
export const searchRouter = router({
  global: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(
      z.object({
        q: z.string().trim().min(1).max(200),
        limitPerObject: z.number().int().min(1).max(20).default(5),
      }),
    )
    .query(async ({ ctx, input }) => {
      const types = await ctx.db.objectType.findMany({
        where: { deletedAt: null },
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      });
      const groups = [];
      for (const ot of types) {
        const attrs = await attributesFor(ctx.db, ot.id);
        const r = await queryRecords(ctx.db, {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          attributes: attrs,
          query: {
            filters: [],
            sort: [],
            search: input.q,
            limit: input.limitPerObject,
            includeDeleted: false,
          },
        });
        if (r.items.length === 0) continue;
        groups.push({
          objectType: {
            id: ot.id,
            apiSlug: ot.apiSlug,
            singular: ot.singular,
            plural: ot.plural,
            icon: ot.icon,
          },
          items: r.items.map((rec) => ({
            ...publicRecord(ctx.actor, attrs, rec),
            label: recordLabel(attrs, rec.values),
          })),
          more: r.nextCursor !== null,
        });
      }
      return { q: input.q, groups };
    }),
});
