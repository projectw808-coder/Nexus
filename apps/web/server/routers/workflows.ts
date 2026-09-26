/**
 * The Automations screen (§12.2.G): trigger → conditions → actions, dry-run, run history,
 * versioning with rollback. CRUD lives here; execution (matching, running, dry-run, versioning)
 * lives in `@nexus/automation` — this router validates input against its schemas and stores the
 * result, it never evaluates a condition or runs an action itself (that only ever happens in
 * apps/worker, off the `automate` queue).
 */
import { NexusError } from '@nexus/core';
import {
  conditionSchema,
  dryRun,
  listWorkflowVersions,
  rollbackWorkflow,
  snapshotWorkflowVersion,
  workflowActionsSchema,
  workflowTriggerSchema,
} from '@nexus/automation';
import type { Prisma } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const asJson = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as never;

function parseOrThrow<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    throw new NexusError('VALIDATION', {
      context: { reason: `Invalid ${what}.` },
      details: { issue: e instanceof Error ? e.message : String(e) },
      cause: e,
    });
  }
}

function parseConditionsInput(raw: unknown): unknown {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];
  return parseOrThrow(() => conditionSchema.parse(raw), 'conditions');
}

const workflowFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  trigger: z.unknown(),
  conditions: z.unknown().optional(),
  actions: z.array(z.unknown()).default([]),
};

export const workflowRouter = router({
  list: tenantProcedure.use(authorize('read', 'Workflow')).query(async ({ ctx }) => {
    const rows = await ctx.db.workflow.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        enabled: true,
        version: true,
        trigger: true,
        lastRunAt: true,
        createdAt: true,
      },
    });
    return rows;
  }),

  get: tenantProcedure
    .use(authorize('read', 'Workflow'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!row) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      return row;
    }),

  create: tenantProcedure
    .use(authorize('create', 'Workflow'))
    .input(z.object(workflowFields))
    .mutation(async ({ ctx, input }) => {
      const trigger = parseOrThrow(() => workflowTriggerSchema.parse(input.trigger), 'trigger');
      const conditions = parseConditionsInput(input.conditions);
      const actions = parseOrThrow(() => workflowActionsSchema.parse(input.actions), 'actions');
      const row = await ctx.db.workflow.create({
        data: {
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description ?? null,
          enabled: false,
          trigger: asJson(trigger),
          conditions: asJson(conditions),
          actions: asJson(actions),
          version: 1,
          createdById: ctx.session.id,
        },
      });
      await snapshotWorkflowVersion(ctx.db, ctx.actor, {
        id: row.id,
        workspaceId: ctx.workspace.id,
        version: 1,
        trigger,
        conditions,
        actions,
      });
      await ctx.audit({
        action: 'workflow.created',
        targetType: 'Workflow',
        targetId: row.id,
        diff: { name: input.name, trigger },
      });
      return row;
    }),

  update: tenantProcedure
    .use(authorize('update', 'Workflow'))
    .input(z.object({ id: z.string().uuid(), ...workflowFields }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { version: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      const trigger = parseOrThrow(() => workflowTriggerSchema.parse(input.trigger), 'trigger');
      const conditions = parseConditionsInput(input.conditions);
      const actions = parseOrThrow(() => workflowActionsSchema.parse(input.actions), 'actions');
      const version = existing.version + 1;
      const row = await ctx.db.workflow.update({
        where: { id: input.id },
        data: {
          name: input.name,
          description: input.description ?? null,
          trigger: asJson(trigger),
          conditions: asJson(conditions),
          actions: asJson(actions),
          version,
        },
      });
      await snapshotWorkflowVersion(ctx.db, ctx.actor, {
        id: row.id,
        workspaceId: ctx.workspace.id,
        version,
        trigger,
        conditions,
        actions,
      });
      await ctx.audit({
        action: 'workflow.updated',
        targetType: 'Workflow',
        targetId: row.id,
        diff: { version },
      });
      return row;
    }),

  setEnabled: tenantProcedure
    .use(authorize('update', 'Workflow'))
    .input(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      const row = await ctx.db.workflow.update({
        where: { id: input.id },
        data: { enabled: input.enabled },
      });
      await ctx.audit({
        action: input.enabled ? 'workflow.enabled' : 'workflow.disabled',
        targetType: 'Workflow',
        targetId: row.id,
      });
      return { id: row.id, enabled: row.enabled };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'Workflow'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      await ctx.db.workflow.update({ where: { id: input.id }, data: { deletedAt: new Date() } });
      await ctx.audit({ action: 'workflow.deleted', targetType: 'Workflow', targetId: input.id });
      return { id: input.id };
    }),

  dryRun: tenantProcedure
    .use(authorize('read', 'Workflow'))
    .input(
      z.object({ id: z.string().uuid(), days: z.number().int().positive().max(30).optional() }),
    )
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { trigger: true, conditions: true, actions: true },
      });
      if (!row) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      return dryRun(ctx.db, ctx.workspace.id, row, { days: input.days });
    }),

  runs: tenantProcedure
    .use(authorize('read', 'Workflow'))
    .input(
      z.object({ id: z.string().uuid(), limit: z.number().int().positive().max(200).default(50) }),
    )
    .query(async ({ ctx, input }) => {
      const existing = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      return ctx.db.workflowRun.findMany({
        where: { workflowId: input.id },
        orderBy: { startedAt: 'desc' },
        take: input.limit,
      });
    }),

  versions: tenantProcedure
    .use(authorize('read', 'Workflow'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const existing = await ctx.db.workflow.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NexusError('NOT_FOUND', { message: 'Workflow not found.' });
      return listWorkflowVersions(ctx.db, input.id);
    }),

  rollback: tenantProcedure
    .use(authorize('update', 'Workflow'))
    .input(z.object({ id: z.string().uuid(), toVersion: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const row = await rollbackWorkflow(ctx.db, ctx.actor, input.id, input.toVersion);
      await ctx.audit({
        action: 'workflow.rolled_back',
        targetType: 'Workflow',
        targetId: input.id,
        diff: { toVersion: input.toVersion, newVersion: row.version },
      });
      return row;
    }),
});
