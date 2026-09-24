import { NexusError } from '@nexus/core';
import { Role, generateToken, hashToken } from '@nexus/db';
import { z } from 'zod';
import { escapeHtml } from '@/lib/mail/provider';
import { assignableRoles } from '../abilities';
import { authorize, publicProcedure, router, tenantProcedure, userProcedure } from '../trpc';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const invitationRouter = router({
  list: tenantProcedure.use(authorize('read', 'Invitation')).query(async ({ ctx }) => {
    const rows = await ctx.db.invitation.findMany({
      where: { deletedAt: null, acceptedAt: null, revokedAt: null },
      include: { invitedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      invitedBy: i.invitedBy?.name ?? i.invitedBy?.email ?? null,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      expired: i.expiresAt.getTime() < now,
    }));
  }),

  create: tenantProcedure
    .use(authorize('invite', 'Membership'))
    .input(
      z.object({ email: z.email().trim().toLowerCase(), role: z.enum(Role).default('MEMBER') }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!assignableRoles(ctx.actor.role).includes(input.role)) {
        throw new NexusError('FORBIDDEN', {
          context: { reason: `Your role cannot invite a ${input.role.toLowerCase()}.` },
        });
      }
      const existing = await ctx.db.membership.findFirst({
        where: { deletedAt: null, user: { email: input.email } },
      });
      if (existing)
        throw new NexusError('CONFLICT', {
          context: { reason: `${input.email} is already a member.` },
        });

      // One live invitation per address: revoke any pending one instead of stacking them.
      await ctx.db.invitation.updateMany({
        where: { email: input.email, acceptedAt: null, revokedAt: null, deletedAt: null },
        data: { revokedAt: new Date() },
      });

      const raw = generateToken();
      const inv = await ctx.db.invitation.create({
        data: {
          workspaceId: ctx.workspace.id,
          email: input.email,
          role: input.role,
          tokenHash: hashToken(raw),
          invitedById: ctx.session.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await ctx.audit({
        action: 'invitation.created',
        targetType: 'Invitation',
        targetId: inv.id,
        diff: { email: inv.email, role: inv.role },
      });

      const link = `${ctx.appUrl}/invite/${raw}`;
      const sent = await ctx.mail.send(
        invitationMail({
          to: inv.email,
          link,
          workspaceName: ctx.workspace.name,
          inviter: ctx.session.name ?? ctx.session.email,
          role: inv.role,
        }),
      );
      if (!sent.ok) throw sent.error;
      return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
    }),

  revoke: tenantProcedure
    .use(authorize('invite', 'Membership'))
    .input(z.object({ invitationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const inv = await ctx.db.invitation.findFirst({
        where: { id: input.invitationId, deletedAt: null, acceptedAt: null, revokedAt: null },
      });
      if (!inv) throw new NexusError('NOT_FOUND');
      await ctx.db.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
      await ctx.audit({
        action: 'invitation.revoked',
        targetType: 'Invitation',
        targetId: inv.id,
        diff: { email: inv.email },
      });
      return { id: inv.id };
    }),

  /** What the landing page shows before the user decides to accept. Token-authenticated. */
  preview: publicProcedure
    .input(z.object({ token: z.string().min(16).max(128) }))
    .query(({ ctx, input }) => ctx.tenancy.previewInvitation(input.token)),

  accept: userProcedure
    .input(z.object({ token: z.string().min(16).max(128) }))
    .mutation(({ ctx, input }) =>
      ctx.tenancy.acceptInvitation({
        userId: ctx.session.id,
        userEmail: ctx.session.email,
        rawToken: input.token,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),
});

export function invitationMail(p: {
  to: string;
  link: string;
  workspaceName: string;
  inviter: string;
  role: Role;
}) {
  const role = p.role.toLowerCase();
  const text = `${p.inviter} invited you to join ${p.workspaceName} on Nexus as a ${role}.\n\nAccept the invitation:\n${p.link}\n\nThe link is valid for 7 days. If you were not expecting this, ignore this email.`;
  const html = `<p>${escapeHtml(p.inviter)} invited you to join <strong>${escapeHtml(p.workspaceName)}</strong> on Nexus as a ${role}.</p>
<p><a href="${p.link}">Accept the invitation</a></p>
<p style="color:#898781">The link is valid for 7 days. If you were not expecting this, ignore this email.</p>`;
  return { to: p.to, subject: `Join ${p.workspaceName} on Nexus`, html, text, kind: 'invitation' };
}
