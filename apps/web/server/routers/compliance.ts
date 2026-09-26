/**
 * Data-subject requests and the platform compliance notes (§5.5).
 *
 * `dataSubjectRequest.create` enqueues `dsr.process` the moment the row commits — nobody filing
 * a GDPR request waits for a scheduled sweep. The job itself runs in `apps/worker`
 * (`src/compliance.ts`), or inline when Redis is unreachable, exactly like every other job
 * dispatched from the web tier (ADR-010).
 */
import { NexusError } from '@nexus/core';
import { DsrKind, DsrStatus, listComplianceNotes } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const kindEnum = z.enum(Object.values(DsrKind) as [DsrKind, ...DsrKind[]]);
const statusEnum = z.enum(Object.values(DsrStatus) as [DsrStatus, ...DsrStatus[]]);

const SELECT = {
  id: true,
  kind: true,
  status: true,
  subjectEmail: true,
  subjectPhone: true,
  subjectRecordId: true,
  requestedAt: true,
  dueAt: true,
  completedAt: true,
  exportRef: true,
  tombstone: true,
  notes: true,
  requestedBy: { select: { name: true, email: true } },
} as const;

/** GDPR Art. 12: one month to respond. Shown as the due date on the queue. */
const RESPONSE_WINDOW_DAYS = 30;

export const dataSubjectRequestRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'DataSubjectRequest'))
    .input(z.object({ status: statusEnum.optional() }).default({}))
    .query(async ({ ctx, input }) =>
      ctx.db.dataSubjectRequest.findMany({
        where: { deletedAt: null, ...(input.status ? { status: input.status } : {}) },
        orderBy: [{ requestedAt: 'desc' }],
        take: 200,
        select: SELECT,
      }),
    ),

  get: tenantProcedure
    .use(authorize('read', 'DataSubjectRequest'))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.dataSubjectRequest.findFirst({
        where: { id: input.id, deletedAt: null },
        select: SELECT,
      });
      if (!row) throw new NexusError('NOT_FOUND');
      return row;
    }),

  /**
   * File a request. At least one way of identifying the subject is required — an erasure with no
   * selector would resolve to nothing and "succeed" having erased nobody, which is worse than an
   * error.
   */
  create: tenantProcedure
    .use(authorize('create', 'DataSubjectRequest'))
    .input(
      z
        .object({
          kind: kindEnum,
          subjectEmail: z.email().nullable().optional(),
          subjectPhone: z.string().trim().min(3).max(40).nullable().optional(),
          subjectRecordId: z.string().uuid().nullable().optional(),
          notes: z.string().trim().max(2000).nullable().optional(),
        })
        .refine(
          (v) => Boolean(v.subjectEmail ?? v.subjectPhone ?? v.subjectRecordId),
          'Give an email, a phone number or a person record so the subject can be found.',
        ),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.subjectRecordId) {
        const record = await ctx.db.record.findFirst({
          where: { id: input.subjectRecordId, deletedAt: null },
          select: { id: true },
        });
        if (!record) throw new NexusError('NOT_FOUND');
      }
      const row = await ctx.db.dataSubjectRequest.create({
        data: {
          workspaceId: ctx.workspace.id,
          kind: input.kind,
          subjectEmail: input.subjectEmail ?? null,
          subjectPhone: input.subjectPhone ?? null,
          subjectRecordId: input.subjectRecordId ?? null,
          notes: input.notes ?? null,
          requestedById: ctx.session.id,
          dueAt: new Date(Date.now() + RESPONSE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        },
        select: { id: true, kind: true, status: true },
      });
      await ctx.audit({
        action: 'dsr.created',
        targetType: 'DataSubjectRequest',
        targetId: row.id,
        diff: {
          kind: input.kind,
          subjectEmail: input.subjectEmail ?? null,
          subjectRecordId: input.subjectRecordId ?? null,
        },
      });
      // Committed first (ADR-010): the dispatcher fires after this transaction lands.
      const dispatch = await ctx.jobs.dispatch('dsr.process', {
        workspaceId: ctx.workspace.id,
        requestId: row.id,
      });
      return { ...row, dispatch: dispatch.mode };
    }),

  /**
   * Release a finished export to the requester. Deliberately manual: the job stops at
   * `EXPORT_READY` because handing someone a copy of a person's data is the step that needs a
   * human to have checked the requester is who they say they are.
   */
  release: tenantProcedure
    .use(authorize('update', 'DataSubjectRequest'))
    .input(z.object({ id: z.string().uuid(), notes: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.dataSubjectRequest.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, status: true, exportRef: true },
      });
      if (!row) throw new NexusError('NOT_FOUND');
      if (row.status !== 'EXPORT_READY') {
        throw new NexusError('CONFLICT', {
          message: `Only an EXPORT_READY request can be released (this one is ${row.status}).`,
        });
      }
      await ctx.db.dataSubjectRequest.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });
      await ctx.audit({
        action: 'dsr.export_released',
        targetType: 'DataSubjectRequest',
        targetId: row.id,
        diff: { exportRef: row.exportRef },
      });
      return { id: row.id };
    }),

  reject: tenantProcedure
    .use(authorize('update', 'DataSubjectRequest'))
    .input(z.object({ id: z.string().uuid(), reason: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.dataSubjectRequest.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!row) throw new NexusError('NOT_FOUND');
      if (row.status === 'COMPLETED') {
        throw new NexusError('CONFLICT', { message: 'That request is already completed.' });
      }
      await ctx.db.dataSubjectRequest.update({
        where: { id: row.id },
        data: { status: 'REJECTED', completedAt: new Date(), notes: input.reason },
      });
      await ctx.audit({
        action: 'dsr.rejected',
        targetType: 'DataSubjectRequest',
        targetId: row.id,
        diff: { reason: input.reason },
      });
      return { id: row.id };
    }),
});

export const complianceNoteRouter = router({
  /**
   * The platform terms constraints that apply to what this workspace has actually connected.
   * `PlatformComplianceNote` is global, so the filter is the workspace's own connections.
   */
  list: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(z.object({ all: z.boolean().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const connections = await ctx.db.connection.findMany({
        where: { deletedAt: null },
        select: { platform: true },
        distinct: ['platform'],
      });
      const platforms = connections.map((c) => c.platform);
      const notes = await listComplianceNotes(ctx.db, input.all ? undefined : platforms);
      return { platforms, notes };
    }),
});
