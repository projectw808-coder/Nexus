/**
 * The unified timeline (§6.3, §12.2.B, ADR-003): one stream per record — events attached to
 * the record and events attached to any of its channel identities — or the stream of a single
 * unresolved identity. Filter chips per platform and per event type come back as facets.
 */
import { NexusError } from '@nexus/core';
import { Platform, TimelineType, queryTimeline } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const platforms = z.array(z.enum(Object.values(Platform) as [Platform, ...Platform[]]));
const types = z.array(z.enum(Object.values(TimelineType) as [TimelineType, ...TimelineType[]]));

export const timelineRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(
      z
        .object({
          recordId: z.string().uuid().optional(),
          identityId: z.string().uuid().optional(),
          platforms: platforms.optional(),
          types: types.optional(),
          cursor: z.string().nullable().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .refine((v) => Boolean(v.recordId) !== Boolean(v.identityId), {
          message: 'Pass exactly one of recordId or identityId.',
        }),
    )
    .query(async ({ ctx, input }) => {
      if (input.recordId) {
        const exists = await ctx.db.record.findFirst({
          where: { id: input.recordId },
          select: { id: true },
        });
        if (!exists) throw new NexusError('NOT_FOUND');
      } else if (input.identityId) {
        const exists = await ctx.db.identity.findFirst({
          where: { id: input.identityId, deletedAt: null },
          select: { id: true },
        });
        if (!exists) throw new NexusError('NOT_FOUND');
      }
      return queryTimeline(ctx.db, {
        workspaceId: ctx.workspace.id,
        ...(input.recordId ? { recordId: input.recordId } : {}),
        ...(input.identityId ? { identityId: input.identityId } : {}),
        ...(input.platforms?.length ? { platforms: input.platforms } : {}),
        ...(input.types?.length ? { types: input.types } : {}),
        cursor: input.cursor ?? null,
        limit: input.limit,
      });
    }),
});
