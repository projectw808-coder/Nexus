/**
 * Per-connection permission grants (§5.2, §12.2.C "Permissions" tab): who beyond the base role
 * can read/engage/publish/configure one specific platform connection. `defineAbilityFor`
 * (`apps/web/server/abilities.ts`) already turns these into CASL conditions and
 * `Tenancy.resolveActor` already loads them onto every request's `Actor.grants` — this module is
 * only the CRUD surface the Permissions tab needs.
 */
import type { ConnPermission, GrantSubjectType } from '../generated/prisma/enums.ts';
import type { TenantDb } from '../scoped.ts';

export type ConnectionGrantRow = {
  id: string;
  connectionId: string;
  subjectType: GrantSubjectType;
  subjectId: string;
  permission: ConnPermission;
  createdAt: Date;
};

export async function listConnectionGrants(
  db: TenantDb,
  connectionId: string,
): Promise<ConnectionGrantRow[]> {
  return db.connectionGrant.findMany({
    where: { connectionId, deletedAt: null },
    orderBy: [{ subjectType: 'asc' }, { subjectId: 'asc' }, { permission: 'asc' }],
    select: {
      id: true,
      connectionId: true,
      subjectType: true,
      subjectId: true,
      permission: true,
      createdAt: true,
    },
  });
}

/** Idempotent: granting the same (connection, subject, permission) twice is a no-op, not an error. */
export async function createConnectionGrant(
  db: TenantDb,
  workspaceId: string,
  input: {
    connectionId: string;
    subjectType: GrantSubjectType;
    subjectId: string;
    permission: ConnPermission;
  },
): Promise<{ id: string }> {
  const row = await db.connectionGrant.upsert({
    where: {
      workspaceId_connectionId_subjectType_subjectId_permission: {
        workspaceId,
        connectionId: input.connectionId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        permission: input.permission,
      },
    },
    update: { deletedAt: null },
    create: { workspaceId, ...input },
    select: { id: true },
  });
  return { id: row.id };
}

export async function deleteConnectionGrant(db: TenantDb, id: string): Promise<void> {
  await db.connectionGrant.update({ where: { id }, data: { deletedAt: new Date() } });
}
