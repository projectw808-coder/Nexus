/**
 * `POST /v1/objects/{slug}/records/query` — the cursor-paginated filter DSL (§11.2).
 *
 * The spec writes this path as `records:query`. A colon is not a legal character in a Windows
 * directory name, and the App Router is file-based, so the colon form cannot be expressed here;
 * the operation lives at the `/query` sub-path instead and the OpenAPI document says so. Record
 * ids are UUIDs, so this static segment can never shadow `records/{id}` (Next.js resolves a
 * static segment before a dynamic one in any case).
 *
 * The body is `RecordQuery` from @nexus/core and the handler is a call to `queryRecords` — the
 * filter DSL, the keyset cursor and the 200-row cap already existed; this endpoint is the wire.
 */
import { recordQueryBodySchema } from '@nexus/api';
import { queryRecords } from '@nexus/db';
import { attributesFor, resolveObjectType } from '@/server/objects-helpers';
import { restRoute } from '../../../../_lib/handler';
import { restAttribute, restObjectType, restRecord } from '../../../../_lib/shapes';

export const dynamic = 'force-dynamic';

export const POST = restRoute<{ slug: string }>('READ', async (ctx, params) => {
  const query = ctx.parse(recordQueryBodySchema);
  return ctx.withTenant(async (db, actor) => {
    const ot = await resolveObjectType(db, params.slug);
    const attrs = await attributesFor(db, ot.id);
    const result = await queryRecords(db, {
      workspaceId: actor.workspaceId,
      objectTypeId: ot.id,
      attributes: attrs,
      query,
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
