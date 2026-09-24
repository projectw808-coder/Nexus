import { NexusError } from '@nexus/core';
import { Role } from '@nexus/db';
import { z } from 'zod';
import { assignableRoles } from '../abilities';
import { authorize, router, tenantProcedure } from '../trpc';

const roleSchema = z.enum(Role);

export const memberRouter = router({
  list: tenantProcedure.use(authorize('read', 'Membership')).query(async ({ ctx }) => {
    const rows = await ctx.db.membership.findMany({
      where: { deletedAt: null },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      joinedAt: m.joinedAt,
      isSelf: m.userId === ctx.session.id,
    }));
  }),

  changeRole: tenantProcedure
    .use(authorize('change_role', 'Membership'))
    .input(z.object({ membershipId: z.string().uuid(), role: roleSchema }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.membership.findFirst({
        where: { id: input.membershipId, deletedAt: null },
      });
      if (!target) throw new NexusError('NOT_FOUND');
      if (target.userId === ctx.session.id) {
        throw new NexusError('POLICY_BLOCKED', {
          context: {
            reason: 'You cannot change your own role.',
            detail: 'Ask another owner to change it.',
          },
        });
      }
      const allowed = assignableRoles(ctx.actor.role);
      if (!allowed.includes(input.role) || !allowed.includes(target.role)) {
        throw new NexusError('FORBIDDEN', {
          context: {
            reason: `Your role cannot assign or change ${input.role === target.role ? target.role : input.role}.`,
          },
        });
      }
      if (target.role === 'OWNER' && input.role !== 'OWNER')
        await assertNotLastOwner(ctx.db, target.id);

      const updated = await ctx.db.membership.update({
        where: { id: target.id },
        data: { role: input.role },
      });
      await ctx.audit({
        action: 'member.role_changed',
        targetType: 'Membership',
        targetId: updated.id,
        diff: { role: { from: target.role, to: updated.role }, userId: target.userId },
      });
      return { id: updated.id, role: updated.role };
    }),

  remove: tenantProcedure
    .use(authorize('remove', 'Membership'))
    .input(z.object({ membershipId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.membership.findFirst({
        where: { id: input.membershipId, deletedAt: null },
      });
      if (!target) throw new NexusError('NOT_FOUND');
      if (target.userId === ctx.session.id) {
        throw new NexusError('POLICY_BLOCKED', {
          context: {
            reason: 'You cannot remove yourself.',
            detail: 'Use "Leave workspace" instead.',
          },
        });
      }
      if (!assignableRoles(ctx.actor.role).includes(target.role)) {
        throw new NexusError('FORBIDDEN', {
          context: { reason: `Your role cannot remove a ${target.role.toLowerCase()}.` },
        });
      }
      if (target.role === 'OWNER') await assertNotLastOwner(ctx.db, target.id);

      await ctx.db.membership.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
      await ctx.audit({
        action: 'member.removed',
        targetType: 'Membership',
        targetId: target.id,
        diff: { userId: target.userId, role: target.role },
      });
      return { id: target.id };
    }),
});

async function assertNotLastOwner(
  db: Parameters<Parameters<typeof tenantProcedure.query>[0]>[0]['ctx']['db'],
  exceptId: string,
) {
  const owners = await db.membership.count({
    where: { role: 'OWNER', deletedAt: null, id: { not: exceptId } },
  });
  if (owners === 0) {
    throw new NexusError('POLICY_BLOCKED', {
      context: {
        reason: 'A workspace needs at least one owner.',
        detail: 'Promote someone else to owner first.',
      },
    });
  }
}
