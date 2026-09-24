/**
 * Cross-workspace operations that legitimately need the system scope, kept inside packages/db
 * so no app code ever holds an unscoped client: listing a user's workspaces, resolving the
 * actor for a request, creating a workspace, and accepting an invitation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NexusError } from '@nexus/core';
import { writeSystemAudit } from './audit.ts';
import { seedSystemObjects } from './objects/system.ts';
import type { Role } from './generated/prisma/enums.ts';
import type { Actor, ActorGrant, TenantRuntime } from './scoped.ts';

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: Role;
  joinedAt: Date | null;
};

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createTenancy(runtime: TenantRuntime) {
  return {
    async listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
      return runtime.withSystem(async (db) => {
        const rows = await db.membership.findMany({
          where: { userId, deletedAt: null, workspace: { deletedAt: null } },
          include: { workspace: true },
          orderBy: { createdAt: 'asc' },
        });
        return rows.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          slug: m.workspace.slug,
          role: m.role,
          joinedAt: m.joinedAt,
        }));
      });
    },

    /** The actor for (user, workspace slug), or null when the user is not a member. */
    async resolveActor(
      userId: string,
      slug: string,
      request: { ip?: string | null; userAgent?: string | null } = {},
    ): Promise<(Actor & { workspace: { id: string; name: string; slug: string } }) | null> {
      return runtime.withSystem(async (db) => {
        const membership = await db.membership.findFirst({
          where: { userId, deletedAt: null, workspace: { slug, deletedAt: null } },
          include: { workspace: { select: { id: true, name: true, slug: true } } },
        });
        if (!membership) return null;
        const grantRows = await db.connectionGrant.findMany({
          where: {
            workspaceId: membership.workspaceId,
            deletedAt: null,
            OR: [
              { subjectType: 'USER', subjectId: userId },
              { subjectType: 'ROLE', subjectId: membership.role },
            ],
          },
          select: { connectionId: true, permission: true },
        });
        const grants: ActorGrant[] = grantRows.map((g) => ({
          connectionId: g.connectionId,
          permission: g.permission,
        }));
        return {
          workspaceId: membership.workspaceId,
          userId,
          role: membership.role,
          grants,
          actorType: 'USER',
          ip: request.ip ?? null,
          userAgent: request.userAgent ?? null,
          workspace: membership.workspace,
        };
      });
    },

    /**
     * Workspaces created before Phase 2 have no Person/Company/Deal object types. Seed them
     * once, idempotently; called when a workspace is opened. Returns true when it seeded.
     */
    async ensureSystemObjects(workspaceId: string): Promise<boolean> {
      return runtime.withSystem(async (db) => {
        const existing = await db.objectType.count({
          where: { workspaceId, isSystem: true, deletedAt: null },
        });
        if (existing > 0) return false;
        await seedSystemObjects(db, workspaceId);
        return true;
      });
    },

    async createWorkspace(input: {
      name: string;
      slug: string;
      region?: string;
      ownerUserId: string;
      ip?: string | null;
      userAgent?: string | null;
    }): Promise<{ id: string; slug: string }> {
      const name = input.name.trim();
      if (name.length < 2 || name.length > 80) {
        throw new NexusError('VALIDATION', {
          context: { reason: 'Workspace name must be 2–80 characters.' },
        });
      }
      if (!SLUG_PATTERN.test(input.slug)) {
        throw new NexusError('VALIDATION', {
          context: {
            reason:
              'Slug must be 3–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.',
          },
        });
      }
      return runtime.withSystem(async (db) => {
        const taken = await db.workspace.findUnique({ where: { slug: input.slug } });
        if (taken) {
          throw new NexusError('CONFLICT', { context: { reason: 'That slug is already taken.' } });
        }
        const ws = await db.workspace.create({
          data: { name, slug: input.slug, region: input.region ?? 'eu', settings: {} },
        });
        const membership = await db.membership.create({
          data: {
            workspaceId: ws.id,
            userId: input.ownerUserId,
            role: 'OWNER',
            joinedAt: new Date(),
          },
        });
        await seedSystemObjects(db, ws.id);
        await writeSystemAudit(
          db,
          ws.id,
          { userId: input.ownerUserId, ip: input.ip, userAgent: input.userAgent },
          {
            action: 'workspace.created',
            targetType: 'Workspace',
            targetId: ws.id,
            diff: { name, slug: ws.slug },
          },
        );
        await writeSystemAudit(
          db,
          ws.id,
          { userId: input.ownerUserId, ip: input.ip, userAgent: input.userAgent },
          {
            action: 'member.joined',
            targetType: 'Membership',
            targetId: membership.id,
            diff: { role: 'OWNER' },
          },
        );
        return { id: ws.id, slug: ws.slug };
      });
    },

    /** Look up an invitation by its raw token without accepting it (for the landing page). */
    async previewInvitation(
      rawToken: string,
    ): Promise<
      | { ok: true; workspaceName: string; email: string; role: Role; expiresAt: Date }
      | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'accepted' }
    > {
      return runtime.withSystem(async (db) => {
        const inv = await db.invitation.findUnique({
          where: { tokenHash: hashToken(rawToken) },
          include: { workspace: { select: { name: true } } },
        });
        if (!inv || inv.deletedAt) return { ok: false, reason: 'not_found' };
        if (inv.revokedAt) return { ok: false, reason: 'revoked' };
        if (inv.acceptedAt) return { ok: false, reason: 'accepted' };
        if (inv.expiresAt < new Date()) return { ok: false, reason: 'expired' };
        return {
          ok: true,
          workspaceName: inv.workspace.name,
          email: inv.email,
          role: inv.role,
          expiresAt: inv.expiresAt,
        };
      });
    },

    /**
     * Accept an invitation as the signed-in user. The user's email must match the invitation's
     * (case-insensitively, citext). Creates or re-activates the membership, marks the invitation
     * accepted, writes the audit row. Returns the workspace slug to redirect to.
     */
    async acceptInvitation(input: {
      userId: string;
      userEmail: string;
      rawToken: string;
      ip?: string | null;
      userAgent?: string | null;
    }): Promise<{ workspaceId: string; slug: string }> {
      return runtime.withSystem(async (db) => {
        const inv = await db.invitation.findUnique({
          where: { tokenHash: hashToken(input.rawToken) },
          include: { workspace: { select: { id: true, slug: true } } },
        });
        if (!inv || inv.deletedAt)
          throw new NexusError('NOT_FOUND', {
            context: { reason: 'This invitation does not exist.' },
          });
        if (inv.revokedAt)
          throw new NexusError('POLICY_BLOCKED', {
            context: {
              reason: 'This invitation was revoked.',
              detail: 'Ask a workspace admin to invite you again.',
            },
          });
        if (inv.acceptedAt)
          throw new NexusError('CONFLICT', {
            context: { reason: 'This invitation was already used.' },
          });
        if (inv.expiresAt < new Date())
          throw new NexusError('POLICY_BLOCKED', {
            context: {
              reason: 'This invitation has expired.',
              detail: 'Ask a workspace admin to send a new one.',
            },
          });
        if (inv.email.toLowerCase() !== input.userEmail.toLowerCase()) {
          throw new NexusError('FORBIDDEN', {
            context: {
              reason: `This invitation was sent to ${inv.email}. Sign in with that address to accept it.`,
            },
          });
        }

        const existing = await db.membership.findUnique({
          where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: input.userId } },
        });
        const membership = existing
          ? await db.membership.update({
              where: { id: existing.id },
              data: {
                role: inv.role,
                deletedAt: null,
                joinedAt: existing.joinedAt ?? new Date(),
                invitedById: inv.invitedById,
              },
            })
          : await db.membership.create({
              data: {
                workspaceId: inv.workspaceId,
                userId: input.userId,
                role: inv.role,
                invitedById: inv.invitedById,
                joinedAt: new Date(),
              },
            });
        await db.invitation.update({
          where: { id: inv.id },
          data: { acceptedAt: new Date(), acceptedByUserId: input.userId },
        });
        await writeSystemAudit(
          db,
          inv.workspaceId,
          { userId: input.userId, ip: input.ip, userAgent: input.userAgent },
          {
            action: 'invitation.accepted',
            targetType: 'Membership',
            targetId: membership.id,
            diff: { invitationId: inv.id, role: inv.role, email: inv.email },
          },
        );
        return { workspaceId: inv.workspaceId, slug: inv.workspace.slug };
      });
    },
  };
}

export type Tenancy = ReturnType<typeof createTenancy>;
