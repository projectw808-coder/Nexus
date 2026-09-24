import { ATTRIBUTE_TYPES, INDEXABLE_TYPES, NexusError, parseAttributeConfig } from '@nexus/core';
import { AttributeAccess, Role, diffOf, type Prisma } from '@nexus/db';
import { z } from 'zod';
import { attributesFor, publicAttributes, resolveObjectType } from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

const slug = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    'lowercase letters, digits and underscores, starting with a letter',
  );
const RETENTION_MS = 24 * 60 * 60 * 1000;

export const objectTypeRouter = router({
  list: tenantProcedure.use(authorize('read', 'ObjectType')).query(async ({ ctx }) => {
    const rows = await ctx.db.objectType.findMany({
      where: { deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: {
            records: { where: { deletedAt: null, mergeState: 'ACTIVE' } },
            attributes: { where: { deletedAt: null } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      apiSlug: r.apiSlug,
      singular: r.singular,
      plural: r.plural,
      icon: r.icon,
      description: r.description,
      isSystem: r.isSystem,
      recordCount: r._count.records,
      attributeCount: r._count.attributes,
    }));
  }),

  get: tenantProcedure
    .use(authorize('read', 'ObjectType'))
    .input(z.object({ objectType: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const ot = await resolveObjectType(ctx.db, input.objectType);
      const attrs = await attributesFor(ctx.db, ot.id);
      const recordCount = await ctx.db.record.count({
        where: { objectTypeId: ot.id, deletedAt: null, mergeState: 'ACTIVE' },
      });
      const deleted = await ctx.db.attribute.findMany({
        where: { objectTypeId: ot.id, deletedAt: { not: null }, purgeAfter: { gt: new Date() } },
        select: {
          id: true,
          apiSlug: true,
          title: true,
          type: true,
          deletedAt: true,
          purgeAfter: true,
        },
      });
      return {
        ...ot,
        recordCount,
        attributes: publicAttributes(ctx.actor, attrs),
        recentlyDeleted: deleted,
      };
    }),

  create: tenantProcedure
    .use(authorize('create', 'ObjectType'))
    .input(
      z.object({
        apiSlug: slug,
        singular: z.string().trim().min(1).max(60),
        plural: z.string().trim().min(1).max(60),
        icon: z.string().max(40).optional(),
        description: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const taken = await ctx.db.objectType.findFirst({ where: { apiSlug: input.apiSlug } });
      if (taken)
        throw new NexusError('CONFLICT', {
          context: { reason: `An object with the slug "${input.apiSlug}" already exists.` },
        });
      const row = await ctx.db.objectType.create({
        data: {
          workspaceId: ctx.workspace.id,
          apiSlug: input.apiSlug,
          singular: input.singular,
          plural: input.plural,
          icon: input.icon ?? null,
          description: input.description ?? null,
        },
      });
      // Every object gets a required name attribute so records always have a label.
      await ctx.db.attribute.create({
        data: {
          workspaceId: ctx.workspace.id,
          objectTypeId: row.id,
          apiSlug: 'name',
          title: 'Name',
          type: 'TEXT',
          isRequired: true,
          isSystem: true,
          position: 0,
        },
      });
      await ctx.audit({
        action: 'object_type.created',
        targetType: 'ObjectType',
        targetId: row.id,
        diff: { apiSlug: row.apiSlug, singular: row.singular },
      });
      return { id: row.id, apiSlug: row.apiSlug };
    }),

  update: tenantProcedure
    .use(authorize('update', 'ObjectType'))
    .input(
      z.object({
        id: z.string().uuid(),
        singular: z.string().trim().min(1).max(60).optional(),
        plural: z.string().trim().min(1).max(60).optional(),
        icon: z.string().max(40).nullable().optional(),
        description: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.objectType.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!before) throw new NexusError('NOT_FOUND');
      const { id, ...data } = input;
      const after = await ctx.db.objectType.update({ where: { id }, data });
      await ctx.audit({
        action: 'object_type.updated',
        targetType: 'ObjectType',
        targetId: id,
        diff: diffOf(
          {
            singular: before.singular,
            plural: before.plural,
            icon: before.icon,
            description: before.description,
          },
          {
            singular: after.singular,
            plural: after.plural,
            icon: after.icon,
            description: after.description,
          },
        ),
      });
      return { id: after.id };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'ObjectType'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ot = await ctx.db.objectType.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!ot) throw new NexusError('NOT_FOUND');
      if (ot.isSystem)
        throw new NexusError('POLICY_BLOCKED', {
          context: { reason: `${ot.singular} is a system object and cannot be deleted.` },
        });
      const now = new Date();
      await ctx.db.objectType.update({ where: { id: ot.id }, data: { deletedAt: now } });
      await ctx.db.attribute.updateMany({
        where: { objectTypeId: ot.id, deletedAt: null },
        data: { deletedAt: now, purgeAfter: new Date(now.getTime() + RETENTION_MS) },
      });
      await ctx.audit({
        action: 'object_type.deleted',
        targetType: 'ObjectType',
        targetId: ot.id,
        diff: { apiSlug: ot.apiSlug },
      });
      return { id: ot.id };
    }),
});

const attributeInput = z.object({
  objectTypeId: z.string().uuid(),
  apiSlug: slug,
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  type: z.enum(ATTRIBUTE_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  isIndexed: z.boolean().default(false),
});

export const attributeRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Attribute'))
    .input(z.object({ objectType: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const ot = await resolveObjectType(ctx.db, input.objectType);
      return publicAttributes(ctx.actor, await attributesFor(ctx.db, ot.id));
    }),

  /** "This will add a column to N records" — what an index or a new attribute touches. */
  migrationPreview: tenantProcedure
    .use(authorize('read', 'Attribute'))
    .input(z.object({ objectTypeId: z.string().uuid(), type: z.enum(ATTRIBUTE_TYPES).optional() }))
    .query(async ({ ctx, input }) => {
      const recordCount = await ctx.db.record.count({
        where: { objectTypeId: input.objectTypeId },
      });
      return {
        recordCount,
        indexable: input.type ? INDEXABLE_TYPES.has(input.type) : null,
        retentionHours: 24,
      };
    }),

  create: tenantProcedure
    .use(authorize('create', 'Attribute'))
    .input(attributeInput)
    .mutation(async ({ ctx, input }) => {
      const ot = await ctx.db.objectType.findFirst({
        where: { id: input.objectTypeId, deletedAt: null },
      });
      if (!ot) throw new NexusError('NOT_FOUND');
      const config = parseAttributeConfig(input.type, input.config);
      if (!config.ok) throw config.error;
      if (input.isIndexed && !INDEXABLE_TYPES.has(input.type)) {
        throw new NexusError('VALIDATION', {
          context: { reason: `${input.type} attributes cannot be indexed.` },
        });
      }
      const clash = await ctx.db.attribute.findFirst({
        where: { objectTypeId: ot.id, apiSlug: input.apiSlug, deletedAt: null },
      });
      if (clash)
        throw new NexusError('CONFLICT', {
          context: { reason: `An attribute with the slug "${input.apiSlug}" already exists.` },
        });
      const last = await ctx.db.attribute.findFirst({
        where: { objectTypeId: ot.id },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const row = await ctx.db.attribute.create({
        data: {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          apiSlug: input.apiSlug,
          title: input.title,
          description: input.description ?? null,
          type: input.type,
          config: config.value as Prisma.InputJsonValue,
          isRequired: input.isRequired,
          isUnique: input.isUnique,
          isIndexed: input.isIndexed,
          indexState: input.isIndexed ? 'BUILDING' : 'NONE',
          position: (last?.position ?? -1) + 1,
        },
      });
      await ctx.audit({
        action: 'attribute.created',
        targetType: 'Attribute',
        targetId: row.id,
        diff: {
          objectTypeId: ot.id,
          apiSlug: row.apiSlug,
          type: row.type,
          isIndexed: row.isIndexed,
        },
      });
      if (input.isIndexed) await ctx.jobs.dispatch('index.build', { attributeId: row.id });
      return { id: row.id, apiSlug: row.apiSlug };
    }),

  update: tenantProcedure
    .use(authorize('update', 'Attribute'))
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).nullable().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        isRequired: z.boolean().optional(),
        isUnique: z.boolean().optional(),
        /** Renaming the slug is allowed (values are keyed by id); system slugs are protected. */
        apiSlug: slug.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.attribute.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!before) throw new NexusError('NOT_FOUND');
      if (before.isSystem && input.apiSlug && input.apiSlug !== before.apiSlug) {
        throw new NexusError('POLICY_BLOCKED', {
          context: {
            reason:
              'System attributes keep their slug; identity resolution depends on it. You can rename the title.',
          },
        });
      }
      let config: Prisma.InputJsonValue | undefined;
      if (input.config) {
        const parsed = parseAttributeConfig(before.type, input.config);
        if (!parsed.ok) throw parsed.error;
        if (before.isSystem && before.type === 'RELATIONSHIP') {
          const prev = (before.config as Record<string, unknown>)['targetObjectTypeId'];
          if (parsed.value['targetObjectTypeId'] !== prev)
            throw new NexusError('POLICY_BLOCKED', {
              context: { reason: 'System relationships keep their target object.' },
            });
        }
        config = parsed.value as Prisma.InputJsonValue;
      }
      if (input.apiSlug && input.apiSlug !== before.apiSlug) {
        const clash = await ctx.db.attribute.findFirst({
          where: { objectTypeId: before.objectTypeId, apiSlug: input.apiSlug, deletedAt: null },
        });
        if (clash)
          throw new NexusError('CONFLICT', {
            context: { reason: `An attribute with the slug "${input.apiSlug}" already exists.` },
          });
      }
      const after = await ctx.db.attribute.update({
        where: { id: before.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
          ...(input.isUnique !== undefined ? { isUnique: input.isUnique } : {}),
          ...(input.apiSlug !== undefined ? { apiSlug: input.apiSlug } : {}),
          ...(config !== undefined ? { config } : {}),
        },
      });
      await ctx.audit({
        action: 'attribute.updated',
        targetType: 'Attribute',
        targetId: after.id,
        diff: diffOf(
          {
            title: before.title,
            description: before.description,
            isRequired: before.isRequired,
            isUnique: before.isUnique,
            apiSlug: before.apiSlug,
            config: before.config,
          },
          {
            title: after.title,
            description: after.description,
            isRequired: after.isRequired,
            isUnique: after.isUnique,
            apiSlug: after.apiSlug,
            config: after.config,
          },
        ),
      });
      return { id: after.id };
    }),

  /** Flip indexing. Building happens in a job (never a synchronous table rewrite, ADR-009). */
  setIndexed: tenantProcedure
    .use(authorize('update', 'Attribute'))
    .input(z.object({ id: z.string().uuid(), indexed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const attr = await ctx.db.attribute.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!attr) throw new NexusError('NOT_FOUND');
      if (input.indexed && !INDEXABLE_TYPES.has(attr.type))
        throw new NexusError('VALIDATION', {
          context: { reason: `${attr.type} attributes cannot be indexed.` },
        });
      if (input.indexed === attr.isIndexed && attr.indexState !== 'FAILED')
        return { id: attr.id, indexState: attr.indexState };
      const updated = await ctx.db.attribute.update({
        where: { id: attr.id },
        data: input.indexed
          ? { isIndexed: true, indexState: 'BUILDING', indexProgress: 0, indexError: null }
          : { isIndexed: false, indexState: 'DROPPING' },
      });
      await ctx.audit({
        action: input.indexed ? 'attribute.index_requested' : 'attribute.index_dropped',
        targetType: 'Attribute',
        targetId: attr.id,
        diff: { apiSlug: attr.apiSlug },
      });
      await ctx.jobs.dispatch(input.indexed ? 'index.build' : 'index.drop', {
        attributeId: attr.id,
      });
      return { id: updated.id, indexState: updated.indexState };
    }),

  /** Soft delete; the column is kept for 24h and can be restored until then (§12.2.F). */
  delete: tenantProcedure
    .use(authorize('delete', 'Attribute'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const attr = await ctx.db.attribute.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          fieldMappingRules: {
            where: { deletedAt: null },
            include: { fieldMapping: { include: { connections: { select: { label: true } } } } },
          },
        },
      });
      if (!attr) throw new NexusError('NOT_FOUND');
      if (attr.isSystem)
        throw new NexusError('POLICY_BLOCKED', {
          context: {
            reason: `${attr.title} is a system attribute and cannot be deleted.`,
            detail: 'Identity resolution depends on it. You can hide it per role instead.',
          },
        });
      const dependents = attr.fieldMappingRules.flatMap((r) =>
        r.fieldMapping.connections.map((c) => c.label),
      );
      if (dependents.length > 0) {
        throw new NexusError('POLICY_BLOCKED', {
          context: {
            reason: `${attr.title} is mapped by ${dependents.join(', ')}.`,
            detail: 'Remove it from those field mappings first.',
          },
        });
      }
      const now = new Date();
      await ctx.db.attribute.update({
        where: { id: attr.id },
        data: { deletedAt: now, purgeAfter: new Date(now.getTime() + RETENTION_MS) },
      });
      await ctx.audit({
        action: 'attribute.deleted',
        targetType: 'Attribute',
        targetId: attr.id,
        diff: { apiSlug: attr.apiSlug, restorableUntil: new Date(now.getTime() + RETENTION_MS) },
      });
      return { id: attr.id, restorableUntil: new Date(now.getTime() + RETENTION_MS) };
    }),

  restore: tenantProcedure
    .use(authorize('delete', 'Attribute'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const attr = await ctx.db.attribute.findFirst({
        where: { id: input.id, deletedAt: { not: null } },
      });
      if (!attr) throw new NexusError('NOT_FOUND');
      if (!attr.purgeAfter || attr.purgeAfter < new Date())
        throw new NexusError('POLICY_BLOCKED', {
          context: { reason: 'The 24-hour restore window has passed.' },
        });
      const clash = await ctx.db.attribute.findFirst({
        where: { objectTypeId: attr.objectTypeId, apiSlug: attr.apiSlug, deletedAt: null },
      });
      if (clash)
        throw new NexusError('CONFLICT', {
          context: {
            reason: `Another attribute now uses the slug "${attr.apiSlug}". Rename it first.`,
          },
        });
      await ctx.db.attribute.update({
        where: { id: attr.id },
        data: { deletedAt: null, purgeAfter: null },
      });
      await ctx.audit({
        action: 'attribute.restored',
        targetType: 'Attribute',
        targetId: attr.id,
        diff: { apiSlug: attr.apiSlug },
      });
      return { id: attr.id };
    }),

  reorder: tenantProcedure
    .use(authorize('update', 'Attribute'))
    .input(
      z.object({
        objectTypeId: z.string().uuid(),
        ids: z.array(z.string().uuid()).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      for (let i = 0; i < input.ids.length; i++) {
        await ctx.db.attribute.updateMany({
          where: { id: input.ids[i]!, objectTypeId: input.objectTypeId },
          data: { position: i },
        });
      }
      await ctx.audit({
        action: 'attribute.reordered',
        targetType: 'ObjectType',
        targetId: input.objectTypeId,
        diff: { order: input.ids },
      });
      return { ok: true };
    }),

  /** Field-level permission per role (§5.2): HIDDEN | READ | WRITE. */
  setPermission: tenantProcedure
    .use(authorize('update', 'Attribute'))
    .input(
      z.object({
        attributeId: z.string().uuid(),
        role: z.enum(Role),
        access: z.enum(AttributeAccess).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const attr = await ctx.db.attribute.findFirst({
        where: { id: input.attributeId, deletedAt: null },
      });
      if (!attr) throw new NexusError('NOT_FOUND');
      if (input.role === 'OWNER')
        throw new NexusError('POLICY_BLOCKED', {
          context: { reason: 'Owners always see every attribute.' },
        });
      if (input.access === null) {
        await ctx.db.attributePermission.deleteMany({
          where: { attributeId: attr.id, role: input.role },
        });
      } else {
        await ctx.db.attributePermission.upsert({
          where: {
            workspaceId_attributeId_role: {
              workspaceId: ctx.workspace.id,
              attributeId: attr.id,
              role: input.role,
            },
          },
          create: {
            workspaceId: ctx.workspace.id,
            attributeId: attr.id,
            role: input.role,
            access: input.access,
          },
          update: { access: input.access, deletedAt: null },
        });
      }
      await ctx.audit({
        action: 'attribute.permission_set',
        targetType: 'Attribute',
        targetId: attr.id,
        diff: { role: input.role, access: input.access },
      });
      return { ok: true };
    }),
});
