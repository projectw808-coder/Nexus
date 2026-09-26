/**
 * The Permissions tab (§12.2.C): who beyond the base role can read/engage/publish/configure one
 * connection. Reading or changing grants is deliberately narrower than configuring the
 * connection itself — `abilities.ts` denies even a MANAGER read access to `ConnectionGrant`,
 * since handing out access to a platform is a privilege decision, not a sync setting.
 */
import {
  ConnPermission,
  GrantSubjectType,
  createConnectionGrant,
  deleteConnectionGrant,
  listConnectionGrants,
  type TenantDb,
} from '@nexus/db';
import { NexusError } from '@nexus/core';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const permissionEnum = z.enum(
  Object.values(ConnPermission) as [ConnPermission, ...ConnPermission[]],
);
const subjectTypeEnum = z.enum(
  Object.values(GrantSubjectType) as [GrantSubjectType, ...GrantSubjectType[]],
);

async function loadConnectionOrThrow(db: TenantDb, connectionId: string) {
  const connection = await db.connection.findFirst({
    where: { id: connectionId, deletedAt: null },
    select: { id: true, label: true },
  });
  if (!connection) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
  return connection;
}

export const connectionGrantRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'ConnectionGrant'))
    .input(z.object({ connectionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await loadConnectionOrThrow(ctx.db, input.connectionId);
      return listConnectionGrants(ctx.db, input.connectionId);
    }),

  create: tenantProcedure
    .use(authorize('create', 'ConnectionGrant'))
    .input(
      z.object({
        connectionId: z.string().uuid(),
        subjectType: subjectTypeEnum,
        subjectId: z.string().min(1),
        permission: permissionEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const connection = await loadConnectionOrThrow(ctx.db, input.connectionId);
      const row = await createConnectionGrant(ctx.db, ctx.workspace.id, {
        connectionId: input.connectionId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        permission: input.permission,
      });
      await ctx.audit({
        action: 'connection_grant.created',
        targetType: 'ConnectionGrant',
        targetId: row.id,
        diff: {
          connectionId: input.connectionId,
          connectionLabel: connection.label,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          permission: input.permission,
        },
      });
      return row;
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'ConnectionGrant'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.connectionGrant.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Grant not found.' });
      await deleteConnectionGrant(ctx.db, input.id);
      await ctx.audit({
        action: 'connection_grant.deleted',
        targetType: 'ConnectionGrant',
        targetId: input.id,
      });
      return { id: input.id };
    }),
});
