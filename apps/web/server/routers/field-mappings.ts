/**
 * Field mapping (Phase 9 build spec, connection-detail "Field mapping" tab): drag a platform
 * field onto a Nexus attribute, with a live preview of three sample records. Backend only — not
 * wired into `routers/index.ts` yet; that and the UI are built separately.
 */
import { platformSchema } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import {
  assignFieldMapping,
  createFieldMapping,
  deleteFieldMapping,
  getFieldMapping,
  listFieldMappings,
  previewFieldMapping,
  setFieldMappingRules,
  updateFieldMapping,
} from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });

const ruleInput = z.object({
  sourceKind: z.string().trim().min(1),
  sourcePath: z.string().trim().min(1),
  attributeId: z.string().uuid(),
  transform: z.unknown().optional(),
  position: z.number().int().min(0),
});

async function loadOrThrow(ctx: { db: Parameters<typeof getFieldMapping>[0] }, mappingId: string) {
  const mapping = await getFieldMapping(ctx.db, mappingId);
  if (!mapping) throw new NexusError('NOT_FOUND', { message: 'Field mapping not found.' });
  return mapping;
}

export const fieldMappingRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(z.object({ platform: platformSchema.optional() }).default({}))
    .query(async ({ ctx, input }) => listFieldMappings(ctx.db, input.platform)),

  get: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(id)
    .query(async ({ ctx, input }) => loadOrThrow(ctx, input.id)),

  create: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(
      z.object({
        platform: platformSchema,
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await createFieldMapping(ctx.db, ctx.actor, input);
      await ctx.audit({
        action: 'field_mapping.created',
        targetType: 'FieldMapping',
        targetId: row.id,
        diff: { platform: input.platform, name: input.name },
      });
      return row;
    }),

  update: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id: mappingId, ...patch } = input;
      await loadOrThrow(ctx, mappingId);
      await updateFieldMapping(ctx.db, mappingId, patch);
      await ctx.audit({
        action: 'field_mapping.updated',
        targetType: 'FieldMapping',
        targetId: mappingId,
        diff: patch,
      });
      return { id: mappingId };
    }),

  delete: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      await loadOrThrow(ctx, input.id);
      await deleteFieldMapping(ctx.db, input.id);
      await ctx.audit({
        action: 'field_mapping.deleted',
        targetType: 'FieldMapping',
        targetId: input.id,
      });
      return { id: input.id };
    }),

  setRules: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(z.object({ fieldMappingId: z.string().uuid(), rules: z.array(ruleInput) }))
    .mutation(async ({ ctx, input }) => {
      await loadOrThrow(ctx, input.fieldMappingId);
      await setFieldMappingRules(ctx.db, ctx.actor, input.fieldMappingId, input.rules);
      await ctx.audit({
        action: 'field_mapping.rules_set',
        targetType: 'FieldMapping',
        targetId: input.fieldMappingId,
        diff: { ruleCount: input.rules.length },
      });
      return { id: input.fieldMappingId };
    }),

  assign: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(
      z.object({ connectionId: z.string().uuid(), fieldMappingId: z.string().uuid().nullable() }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.fieldMappingId) await loadOrThrow(ctx, input.fieldMappingId);
      await assignFieldMapping(ctx.db, input.connectionId, input.fieldMappingId);
      await ctx.audit({
        action: 'field_mapping.assigned',
        targetType: 'Connection',
        targetId: input.connectionId,
        diff: { fieldMappingId: input.fieldMappingId },
      });
      return { connectionId: input.connectionId, fieldMappingId: input.fieldMappingId };
    }),

  preview: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(
      z.object({
        connectionId: z.string().uuid(),
        kind: z.string().trim().min(1),
        rules: z.array(ruleInput.omit({ position: true })),
      }),
    )
    .query(async ({ ctx, input }) => {
      const connection = await ctx.db.connection.findFirst({
        where: { id: input.connectionId, deletedAt: null },
        select: { id: true },
      });
      if (!connection) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
      return previewFieldMapping(ctx.db, input);
    }),
});
