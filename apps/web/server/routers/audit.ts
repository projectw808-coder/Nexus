import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

export const auditRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'AuditLog'))
    .input(
      z
        .object({
          cursor: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(50),
          targetType: z.string().max(64).optional(),
          action: z.string().max(64).optional(),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.auditLog.findMany({
        where: {
          ...(input.targetType ? { targetType: input.targetType } : {}),
          ...(input.action ? { action: input.action } : {}),
        },
        include: { actorUser: { select: { name: true, email: true } } },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((r) => ({
          id: r.id,
          at: r.at,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          actor: r.actorUser?.name ?? r.actorUser?.email ?? r.actorType.toLowerCase(),
          actorType: r.actorType,
          diff: r.diff,
        })),
        nextCursor: rows.length > input.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    }),
});
