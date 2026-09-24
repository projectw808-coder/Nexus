import { NexusError, detectDelimiter } from '@nexus/core';
import {
  IMPORT_MAX_BYTES,
  loadAttributes,
  previewImport,
  rollbackImport,
  runImport,
  toDef,
  writableAttributes,
  type Prisma,
} from '@nexus/db';
import { z } from 'zod';
import { resolveObjectType } from '../objects-helpers';
import { authorize, router, tenantJobProcedure, tenantProcedure } from '../trpc';

const mappingSchema = z.record(
  z.string(),
  z.union([z.object({ attributeId: z.string().uuid() }), z.object({ skip: z.literal(true) })]),
);
const optionsSchema = z.object({
  dedupeAttributeId: z.string().uuid().nullable().optional(),
  updateExisting: z.boolean().optional(),
});

/**
 * CSV import (§16 Phase 2): `create` stores the file and returns a dry-run preview with a
 * suggested mapping; `preview` re-runs the dry run with an edited mapping; `run` executes in
 * chunks (own transactions, tenantJobProcedure); `rollback` soft-deletes what the run created.
 */
export const importRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'ImportJob'))
    .input(z.object({ objectType: z.string().min(1).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const ot = input.objectType ? await resolveObjectType(ctx.db, input.objectType) : null;
      const rows = await ctx.db.importJob.findMany({
        where: { deletedAt: null, ...(ot ? { objectTypeId: ot.id } : {}) },
        include: {
          createdBy: { select: { name: true, email: true } },
          objectType: { select: { apiSlug: true, plural: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map((j) => ({
        id: j.id,
        fileName: j.fileName,
        status: j.status,
        stats: j.stats,
        progress: j.progress,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        rolledBackAt: j.rolledBackAt,
        by: j.createdBy?.name ?? j.createdBy?.email ?? null,
        objectType: j.objectType,
      }));
    }),

  get: tenantProcedure
    .use(authorize('read', 'ImportJob'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const job = await ctx.db.importJob.findFirst({
        where: { id: input.id, deletedAt: null },
        include: { objectType: { select: { id: true, apiSlug: true, plural: true } } },
      });
      if (!job) throw new NexusError('NOT_FOUND');
      const { sourceText: _omit, ...rest } = job;
      return rest;
    }),

  create: tenantProcedure
    .use(authorize('import', 'ImportJob'))
    .input(
      z.object({
        objectType: z.string().min(1),
        fileName: z.string().min(1).max(200),
        csvText: z.string().min(1),
        delimiter: z.enum([',', ';', '\t']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (Buffer.byteLength(input.csvText, 'utf8') > IMPORT_MAX_BYTES) {
        throw new NexusError('VALIDATION', {
          context: {
            reason: `Files are limited to ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB.`,
          },
        });
      }
      const ot = await resolveObjectType(ctx.db, input.objectType);
      const attrs = writableAttributes(ctx.actor, await loadAttributes(ctx.db, ot.id)).map(toDef);
      const delimiter = input.delimiter ?? detectDelimiter(input.csvText);
      const preview = previewImport(input.csvText, delimiter, attrs);
      const job = await ctx.db.importJob.create({
        data: {
          workspaceId: ctx.workspace.id,
          objectTypeId: ot.id,
          createdById: ctx.session.id,
          fileName: input.fileName,
          delimiter,
          sourceText: input.csvText,
          mapping: preview.mapping as unknown as Prisma.InputJsonValue,
          stats: preview.stats as unknown as Prisma.InputJsonValue,
          errors: preview.errors as unknown as Prisma.InputJsonValue,
        },
      });
      await ctx.audit({
        action: 'import.created',
        targetType: 'ImportJob',
        targetId: job.id,
        diff: { fileName: job.fileName, objectType: ot.apiSlug, rows: preview.stats.total },
      });
      return {
        id: job.id,
        preview,
        attributes: attrs.map((a) => ({
          id: a.id,
          apiSlug: a.apiSlug,
          title: a.title,
          type: a.type,
        })),
      };
    }),

  /** Re-run the dry run with an edited mapping/options; persists them on the job. */
  preview: tenantProcedure
    .use(authorize('import', 'ImportJob'))
    .input(
      z.object({
        id: z.string().uuid(),
        mapping: mappingSchema.optional(),
        options: optionsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const job = await ctx.db.importJob.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!job) throw new NexusError('NOT_FOUND');
      if (job.status !== 'PREVIEW')
        throw new NexusError('CONFLICT', {
          context: {
            reason: `This import is ${job.status.toLowerCase()} and its mapping can no longer change.`,
          },
        });
      const attrs = writableAttributes(
        ctx.actor,
        await loadAttributes(ctx.db, job.objectTypeId),
      ).map(toDef);
      const preview = previewImport(
        job.sourceText,
        job.delimiter,
        attrs,
        input.mapping ?? (job.mapping as Parameters<typeof previewImport>[3]),
      );
      await ctx.db.importJob.update({
        where: { id: job.id },
        data: {
          mapping: preview.mapping as unknown as Prisma.InputJsonValue,
          stats: preview.stats as unknown as Prisma.InputJsonValue,
          errors: preview.errors as unknown as Prisma.InputJsonValue,
          ...(input.options ? { options: input.options as Prisma.InputJsonValue } : {}),
        },
      });
      await ctx.audit({
        action: 'import.previewed',
        targetType: 'ImportJob',
        targetId: job.id,
        diff: { valid: preview.stats.valid, invalid: preview.stats.invalid },
      });
      return preview;
    }),

  run: tenantJobProcedure
    .use(authorize('import', 'ImportJob'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const stats = await runImport(ctx.runtime, ctx.actor, input.id);
      await ctx.audit({
        action: 'import.completed',
        targetType: 'ImportJob',
        targetId: input.id,
        diff: stats,
      });
      return stats;
    }),

  rollback: tenantProcedure
    .use(authorize('import', 'ImportJob'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const r = await rollbackImport(ctx.db, input.id);
      await ctx.audit({
        action: 'import.rolled_back',
        targetType: 'ImportJob',
        targetId: input.id,
        diff: r,
      });
      return r;
    }),
});
