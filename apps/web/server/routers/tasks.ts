import { NexusError } from '@nexus/core';
import { emitTimelineEvent } from '@nexus/db';
import { TaskPriority, TaskStatus, diffOf } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const taskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  priority: z.enum(TaskPriority).default('NORMAL'),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
};

/** Tasks attached to a record (§12.2.B) or standalone. */
export const taskRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'Task'))
    .input(
      z
        .object({
          recordId: z.string().uuid().optional(),
          mine: z.boolean().optional(),
          includeDone: z.boolean().default(false),
        })
        .default({ includeDone: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.task.findMany({
        where: {
          deletedAt: null,
          ...(input.recordId ? { recordId: input.recordId } : {}),
          ...(input.mine ? { assigneeId: ctx.session.id } : {}),
          ...(input.includeDone ? {} : { status: { in: ['OPEN', 'IN_PROGRESS'] } }),
        },
        include: { assignee: { select: { id: true, name: true, email: true } } },
        orderBy: [
          { status: 'asc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
      });
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        dueAt: t.dueAt,
        completedAt: t.completedAt,
        assignee: t.assignee,
        recordId: t.recordId,
        overdue:
          !!t.dueAt && t.dueAt < new Date() && (t.status === 'OPEN' || t.status === 'IN_PROGRESS'),
      }));
    }),

  create: tenantProcedure
    .use(authorize('create', 'Task'))
    .input(z.object({ recordId: z.string().uuid().optional(), ...taskFields }))
    .mutation(async ({ ctx, input }) => {
      if (input.recordId) {
        const record = await ctx.db.record.findFirst({
          where: { id: input.recordId, deletedAt: null },
          select: { id: true },
        });
        if (!record) throw new NexusError('NOT_FOUND');
      }
      if (input.assigneeId) await assertMember(ctx.db, input.assigneeId);
      const task = await ctx.db.task.create({
        data: {
          workspaceId: ctx.workspace.id,
          recordId: input.recordId ?? null,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority,
          dueAt: input.dueAt ?? null,
          assigneeId: input.assigneeId ?? null,
          createdById: ctx.session.id,
        },
      });
      if (task.recordId)
        await emitTimelineEvent(ctx.db, {
          workspaceId: ctx.workspace.id,
          dedupeKey: `task:${task.id}`,
          type: 'TASK',
          occurredAt: task.createdAt,
          recordId: task.recordId,
          actorUserId: ctx.session.id,
          summary: `Created the task “${task.title}”${task.dueAt ? ` due ${task.dueAt.toISOString().slice(0, 10)}` : ''}`,
          payload: {
            kind: 'task',
            taskId: task.id,
            priority: task.priority,
            assigneeId: task.assigneeId,
          },
        });
      await ctx.audit({
        action: 'task.created',
        targetType: 'Task',
        targetId: task.id,
        diff: { title: task.title, recordId: task.recordId, assigneeId: task.assigneeId },
      });
      return { id: task.id };
    }),

  update: tenantProcedure
    .use(authorize('update', 'Task'))
    .input(
      z.object({
        id: z.string().uuid(),
        title: taskFields.title.optional(),
        description: taskFields.description,
        priority: z.enum(TaskPriority).optional(),
        dueAt: taskFields.dueAt,
        assigneeId: taskFields.assigneeId,
        status: z.enum(TaskStatus).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.task.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!before) throw new NexusError('NOT_FOUND');
      if (input.assigneeId) await assertMember(ctx.db, input.assigneeId);
      const done = input.status === 'DONE' || input.status === 'CANCELLED';
      const after = await ctx.db.task.update({
        where: { id: before.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          ...(input.status !== undefined
            ? { status: input.status, completedAt: done ? new Date() : null }
            : {}),
        },
      });
      await ctx.audit({
        action: 'task.updated',
        targetType: 'Task',
        targetId: after.id,
        diff: diffOf(
          {
            title: before.title,
            status: before.status,
            priority: before.priority,
            dueAt: before.dueAt,
            assigneeId: before.assigneeId,
          },
          {
            title: after.title,
            status: after.status,
            priority: after.priority,
            dueAt: after.dueAt,
            assigneeId: after.assigneeId,
          },
        ),
      });
      return { id: after.id, status: after.status };
    }),

  delete: tenantProcedure
    .use(authorize('delete', 'Task'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.db.task.findFirst({ where: { id: input.id, deletedAt: null } });
      if (!task) throw new NexusError('NOT_FOUND');
      await ctx.db.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
      await ctx.audit({
        action: 'task.deleted',
        targetType: 'Task',
        targetId: task.id,
        diff: { title: task.title },
      });
      return { id: task.id };
    }),
});

async function assertMember(
  db: Parameters<Parameters<typeof tenantProcedure.query>[0]>[0]['ctx']['db'],
  userId: string,
): Promise<void> {
  const m = await db.membership.findFirst({
    where: { userId, deletedAt: null },
    select: { id: true },
  });
  if (!m)
    throw new NexusError('VALIDATION', {
      context: { reason: 'The assignee is not a member of this workspace.' },
    });
}
