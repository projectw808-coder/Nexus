/**
 * `GET /v1/objects` · `POST /v1/objects` (§11.2).
 *
 * The same object-type list and create the `objectType` tRPC router serves, reached with an API
 * key instead of a session (ADR-022 decision 1) — one transport, one set of rules.
 */
import { createObjectTypeSchema, pageQuerySchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { restRoute } from '../_lib/handler';
import { cappedLimit, decodeDateCursor, paginate, restObjectType } from '../_lib/shapes';

export const dynamic = 'force-dynamic';

export const GET = restRoute('READ', async (ctx) => {
  const { cursor, limit } = ctx.query(pageQuerySchema);
  const take = cappedLimit(limit);
  const after = decodeDateCursor(cursor);
  const rows = await ctx.withTenant((db) =>
    db.objectType.findMany({
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
  return { body: { items: page.items.map(restObjectType), nextCursor: page.nextCursor } };
});

export const POST = restRoute('WRITE', async (ctx) => {
  const input = ctx.parse(createObjectTypeSchema);
  const created = await ctx.withTenant(async (db, actor) => {
    const taken = await db.objectType.findFirst({ where: { apiSlug: input.apiSlug } });
    if (taken) {
      throw new NexusError('CONFLICT', {
        context: { reason: `An object with the slug "${input.apiSlug}" already exists.` },
      });
    }
    const row = await db.objectType.create({
      data: {
        workspaceId: actor.workspaceId,
        apiSlug: input.apiSlug,
        singular: input.singular,
        plural: input.plural,
        icon: input.icon ?? null,
        description: input.description ?? null,
      },
    });
    // Every object gets a required `name` attribute so its records always have a label —
    // the same invariant `objectType.create` establishes in the tRPC router.
    await db.attribute.create({
      data: {
        workspaceId: actor.workspaceId,
        objectTypeId: row.id,
        apiSlug: 'name',
        title: 'Name',
        type: 'TEXT',
        isRequired: true,
        position: 0,
      },
    });
    await ctx.audit(db, {
      action: 'object_type.created',
      targetType: 'ObjectType',
      targetId: row.id,
      diff: { apiSlug: row.apiSlug, via: 'rest_v1' },
    });
    return row;
  });
  return { status: 201, body: restObjectType(created) };
});
