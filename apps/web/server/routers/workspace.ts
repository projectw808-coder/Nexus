import { SLUG_PATTERN, diffOf } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantJobProcedure, tenantProcedure, userProcedure } from '../trpc';

export const workspaceRouter = router({
  /** Workspaces the signed-in user belongs to. */
  list: userProcedure.query(({ ctx }) => ctx.tenancy.listWorkspacesForUser(ctx.session.id)),

  create: userProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(80),
        slug: z.string().regex(SLUG_PATTERN, 'lowercase letters, digits and hyphens'),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenancy.createWorkspace({
        name: input.name,
        slug: input.slug,
        ownerUserId: ctx.session.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  // No ambient transaction: the upgrade path below opens its own (PGlite cannot nest them).
  current: tenantJobProcedure.query(async ({ ctx }) => {
    // A workspace from before the object graph gets its system objects on first open.
    await ctx.tenancy.ensureSystemObjects(ctx.workspace.id);
    const ws = await ctx.runtime.withTenant(ctx.actor, (db) =>
      db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspace.id },
        select: { id: true, name: true, slug: true, plan: true, region: true, createdAt: true },
      }),
    );
    return { ...ws, role: ctx.actor.role };
  }),

  update: tenantProcedure
    .use(authorize('update', 'Workspace'))
    .input(z.object({ name: z.string().trim().min(2).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspace.id },
        select: { name: true },
      });
      const after = await ctx.db.workspace.update({
        where: { id: ctx.workspace.id },
        data: { name: input.name },
        select: { id: true, name: true, slug: true },
      });
      await ctx.audit({
        action: 'workspace.updated',
        targetType: 'Workspace',
        targetId: after.id,
        diff: diffOf(before, { name: after.name }),
      });
      return after;
    }),
});
