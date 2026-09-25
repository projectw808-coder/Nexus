/**
 * The merge review queue (§10): suggestions the resolver could not decide on its own, each
 * with its verbatim signals, accepted or rejected from the keyboard. Accepting an identity
 * suggestion links; accepting a record pair merges (reversibly). Rejecting a record pair
 * writes a `NeverMerge`; rejecting an identity pair is remembered on the suggestion itself.
 */
import { NexusError } from '@nexus/core';
import { linkIdentity, mergeRecords, rescoreSuggestion, type LinkMethod } from '@nexus/db';
import { z } from 'zod';
import { identitySummary, personLabels, signalsOf } from '../identity-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });

const METHODS = new Set<LinkMethod>([
  'EXACT_EMAIL',
  'PHONE',
  'OAUTH_SELF',
  'DOMAIN',
  'NAME_FUZZY',
  'HANDLE_MATCH',
  'MANUAL',
  'AI_INFERRED',
  'PLATFORM_PROVIDED',
]);

async function loadSuggestion(db: Parameters<typeof personLabels>[0], suggestionId: string) {
  const s = await db.mergeSuggestion.findFirst({
    where: { id: suggestionId, deletedAt: null },
    include: {
      identity: true,
      decidedBy: { select: { name: true, email: true } },
    },
  });
  if (!s) throw new NexusError('NOT_FOUND');
  const labels = await personLabels(db, [
    s.rightRecordId,
    ...(s.leftRecordId ? [s.leftRecordId] : []),
  ]);
  return {
    id: s.id,
    kind: s.identityId ? ('identity' as const) : ('record' as const),
    status: s.status,
    score: s.score,
    signals: signalsOf(s.signals),
    identity: s.identity ? identitySummary(s.identity) : null,
    left: s.leftRecordId
      ? { id: s.leftRecordId, label: labels.get(s.leftRecordId)?.label ?? '(person)' }
      : null,
    right: { id: s.rightRecordId, label: labels.get(s.rightRecordId)?.label ?? '(person)' },
    decidedAt: s.decidedAt,
    decidedBy: s.decidedBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const mergeSuggestionRouter = router({
  list: tenantProcedure
    .use(authorize('read', 'MergeSuggestion'))
    .input(
      z
        .object({
          status: z
            .enum(['PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_MERGED', 'EXPIRED'])
            .default('PENDING'),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ status: 'PENDING', limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.mergeSuggestion.findMany({
        where: { status: input.status, deletedAt: null },
        orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
        take: input.limit,
        include: { identity: true },
      });
      const labels = await personLabels(
        ctx.db,
        rows.flatMap((s) => [s.rightRecordId, ...(s.leftRecordId ? [s.leftRecordId] : [])]),
      );
      const total = await ctx.db.mergeSuggestion.count({
        where: { status: 'PENDING', deletedAt: null },
      });
      return {
        pending: total,
        items: rows.map((s) => ({
          id: s.id,
          kind: s.identityId ? ('identity' as const) : ('record' as const),
          status: s.status,
          score: s.score,
          signals: signalsOf(s.signals),
          identity: s.identity ? identitySummary(s.identity) : null,
          left: s.leftRecordId
            ? { id: s.leftRecordId, label: labels.get(s.leftRecordId)?.label ?? '(person)' }
            : null,
          right: { id: s.rightRecordId, label: labels.get(s.rightRecordId)?.label ?? '(person)' },
          createdAt: s.createdAt,
        })),
      };
    }),

  get: tenantProcedure
    .use(authorize('read', 'MergeSuggestion'))
    .input(id)
    .query(({ ctx, input }) => loadSuggestion(ctx.db, input.id)),

  accept: tenantProcedure
    .use(authorize('update', 'MergeSuggestion'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.db.mergeSuggestion.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!s) throw new NexusError('NOT_FOUND');
      if (s.status !== 'PENDING')
        throw new NexusError('CONFLICT', {
          context: { reason: `This suggestion was already ${s.status.toLowerCase()}.` },
        });
      const signals = signalsOf(s.signals);
      if (s.identityId) {
        const method: LinkMethod =
          signals.method && METHODS.has(signals.method as LinkMethod)
            ? (signals.method as LinkMethod)
            : 'MANUAL';
        const r = await linkIdentity(ctx.db, ctx.actor, {
          identityId: s.identityId,
          personRecordId: s.rightRecordId,
          method,
          confidence: Math.max(s.score, 0.4),
          evidence: {
            score: signals.score,
            signals: signals.signals as never,
            note: `Suggestion accepted by ${ctx.session.name ?? ctx.session.email}`,
          },
          confirmed: true,
        });
        await ctx.db.mergeSuggestion.update({
          where: { id: s.id },
          data: { status: 'ACCEPTED', decidedById: ctx.session.id, decidedAt: new Date() },
        });
        await ctx.audit({
          action: 'merge_suggestion.accepted',
          targetType: 'MergeSuggestion',
          targetId: s.id,
          diff: { identityId: s.identityId, personRecordId: s.rightRecordId, linkId: r.linkId },
        });
        return { kind: 'identity' as const, personRecordId: s.rightRecordId, linkId: r.linkId };
      }
      const merge = await mergeRecords(ctx.db, ctx.actor, {
        winnerId: s.rightRecordId,
        loserId: s.leftRecordId!,
        suggestionId: s.id,
        reason: 'suggestion accepted',
      });
      await ctx.audit({
        action: 'merge_suggestion.accepted',
        targetType: 'MergeSuggestion',
        targetId: s.id,
        diff: { mergeId: merge.mergeId, winnerId: merge.winnerId, loserId: merge.loserId },
      });
      return { kind: 'record' as const, personRecordId: merge.winnerId, mergeId: merge.mergeId };
    }),

  reject: tenantProcedure
    .use(authorize('update', 'MergeSuggestion'))
    .input(z.object({ id: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.db.mergeSuggestion.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!s) throw new NexusError('NOT_FOUND');
      if (s.status !== 'PENDING')
        throw new NexusError('CONFLICT', {
          context: { reason: `This suggestion was already ${s.status.toLowerCase()}.` },
        });
      await ctx.db.mergeSuggestion.update({
        where: { id: s.id },
        data: { status: 'REJECTED', decidedById: ctx.session.id, decidedAt: new Date() },
      });
      let neverMergeId: string | null = null;
      if (s.leftRecordId) {
        const [left, right] = [s.leftRecordId, s.rightRecordId].sort() as [string, string];
        const existing = await ctx.db.neverMerge.findFirst({
          where: { leftRecordId: left, rightRecordId: right, deletedAt: null },
          select: { id: true },
        });
        neverMergeId =
          existing?.id ??
          (
            await ctx.db.neverMerge.create({
              data: {
                workspaceId: ctx.workspace.id,
                leftRecordId: left,
                rightRecordId: right,
                decidedById: ctx.session.id,
                reason: input.reason ?? 'Rejected from the merge queue',
              },
              select: { id: true },
            })
          ).id;
      }
      await ctx.audit({
        action: 'merge_suggestion.rejected',
        targetType: 'MergeSuggestion',
        targetId: s.id,
        diff: { reason: input.reason ?? null, neverMergeId },
      });
      return { neverMergeId };
    }),

  /** Re-score one suggestion with today's signals (what the nightly job does for all). */
  rescore: tenantProcedure
    .use(authorize('update', 'MergeSuggestion'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const s = await ctx.db.mergeSuggestion.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      });
      if (!s) throw new NexusError('NOT_FOUND');
      const r = await rescoreSuggestion(ctx.db, ctx.actor, s.id);
      await ctx.audit({
        action: r.promoted ? 'merge_suggestion.auto_merged' : 'merge_suggestion.rescored',
        targetType: 'MergeSuggestion',
        targetId: s.id,
        diff: { status: r.status, score: r.score },
      });
      return r;
    }),
});
