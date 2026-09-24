import { filterSchema, sortSchema, toCsv } from '@nexus/core';
import { queryRecords, redactValues, visibleAttributes } from '@nexus/db';
import { z } from 'zod';
import { attributesFor, resolveObjectType } from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

export const EXPORT_MAX_ROWS = 50_000;

/**
 * Export (§2 "everything a user sees, a user can export"): the same query the list view runs,
 * with the same field-level redaction, as CSV or JSON. Audited.
 */
export const exportRouter = router({
  records: tenantProcedure
    .use(authorize('export', 'Record'))
    .input(
      z.object({
        objectType: z.string().min(1),
        format: z.enum(['csv', 'json']).default('csv'),
        filters: z.array(filterSchema).max(20).default([]),
        sort: z.array(sortSchema).max(3).default([]),
        search: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ot = await resolveObjectType(ctx.db, input.objectType);
      const attrs = await attributesFor(ctx.db, ot.id);
      const visible = visibleAttributes(ctx.actor, attrs);
      const rows: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      while (rows.length < EXPORT_MAX_ROWS) {
        const page = await queryRecords(ctx.db, {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          attributes: attrs,
          query: {
            filters: input.filters,
            sort: input.sort,
            search: input.search,
            cursor,
            limit: 200,
            includeDeleted: false,
          },
        });
        for (const r of page.items)
          rows.push({
            id: r.id,
            ...redactValues(ctx.actor, attrs, r.values),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          });
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      await ctx.audit({
        action: 'export.records',
        targetType: 'ObjectType',
        targetId: ot.id,
        diff: { format: input.format, rows: rows.length, filters: input.filters },
      });
      const stamp = new Date().toISOString().slice(0, 10);
      if (input.format === 'json') {
        return {
          filename: `${ot.apiSlug}-${stamp}.json`,
          contentType: 'application/json',
          body: JSON.stringify(
            rows.map((r) => slugKeyed(r, visible)),
            null,
            2,
          ),
          rows: rows.length,
          truncated: rows.length >= EXPORT_MAX_ROWS,
        };
      }
      const headers = ['id', ...visible.map((a) => a.apiSlug), 'createdAt', 'updatedAt'];
      const body = toCsv(
        headers,
        rows.map((r) => [r['id'], ...visible.map((a) => r[a.id]), r['createdAt'], r['updatedAt']]),
      );
      return {
        filename: `${ot.apiSlug}-${stamp}.csv`,
        contentType: 'text/csv',
        body,
        rows: rows.length,
        truncated: rows.length >= EXPORT_MAX_ROWS,
      };
    }),
});

function slugKeyed(
  r: Record<string, unknown>,
  visible: { id: string; apiSlug: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r['id'] };
  for (const a of visible) if (a.id in r) out[a.apiSlug] = r[a.id];
  out['createdAt'] = r['createdAt'];
  out['updatedAt'] = r['updatedAt'];
  return out;
}
