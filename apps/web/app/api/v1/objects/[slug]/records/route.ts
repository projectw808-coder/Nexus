/**
 * `GET /v1/objects/{slug}/records` · `POST /v1/objects/{slug}/records` (§11.2).
 *
 * `{slug}` is the **object type's** `apiSlug` — there is no workspace in any REST path, because
 * the API key already fixes it (ADR-022 decision 1). The list goes through the same
 * `queryRecords` the `record.query` procedure uses, so the cursor, the 200-row cap and the
 * attribute-aware sorting are the existing ones, not a second implementation.
 */
import { pageQuerySchema, recordValuesSchema } from '@nexus/api';
import { createRecord, queryRecords } from '@nexus/db';
import { z } from 'zod';
import { attributesFor, resolveObjectType } from '@/server/objects-helpers';
import { restRoute } from '../../../_lib/handler';
import { cappedLimit, restAttribute, restObjectType, restRecord } from '../../../_lib/shapes';

export const dynamic = 'force-dynamic';

const listQuery = pageQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const GET = restRoute<{ slug: string }>('READ', async (ctx, params) => {
  const q = ctx.query(listQuery);
  return ctx.withTenant(async (db, actor) => {
    const ot = await resolveObjectType(db, params.slug);
    const attrs = await attributesFor(db, ot.id);
    const result = await queryRecords(db, {
      workspaceId: actor.workspaceId,
      objectTypeId: ot.id,
      attributes: attrs,
      query: {
        filters: [],
        sort: [],
        limit: cappedLimit(q.limit),
        includeDeleted: q.includeDeleted,
        ...(q.search ? { search: q.search } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
    });
    return {
      body: {
        items: result.items.map((r) => restRecord(actor, attrs, r)),
        nextCursor: result.nextCursor,
        attributes: attrs.map(restAttribute),
        objectType: restObjectType(ot),
      },
    };
  });
});

export const POST = restRoute<{ slug: string }>('WRITE', async (ctx, params) => {
  const input = ctx.parse(recordValuesSchema);
  return ctx.withTenant(async (db, actor) => {
    const ot = await resolveObjectType(db, params.slug);
    const attrs = await attributesFor(db, ot.id);
    const row = await createRecord(db, actor, {
      objectTypeId: ot.id,
      attributes: attrs,
      input: input.values,
    });
    await ctx.audit(db, {
      action: 'record.created',
      targetType: 'Record',
      targetId: row.id,
      diff: { objectType: ot.apiSlug, values: row.values, via: 'rest_v1' },
    });
    // A record created over REST re-enters stage 6 exactly as one created in the UI does.
    await ctx.deps.jobs.dispatch('automate.react', {
      workspaceId: actor.workspaceId,
      type: 'record.created',
      occurredAt: new Date().toISOString(),
      recordId: row.id,
      objectTypeApiSlug: ot.apiSlug,
      payload: { values: row.values },
      causation: { workflowIds: [] },
    });
    return { status: 201, body: restRecord(actor, attrs, row) };
  });
});
