/**
 * Channel identities (§6.3, §10): the chips on a person, the unresolved queue, the "why are
 * these the same person?" evidence, and the human overrides — link, unlink, create a person,
 * or run the resolver now. Every override is a confirmed link with the teammate's name on it.
 */
import { NexusError, scorePair } from '@nexus/core';
import {
  candidatePersonsForIdentity,
  createPersonFromIdentity,
  identitySubject,
  linkIdentity,
  personSubject,
  resolveIdentity,
  unlinkIdentity,
} from '@nexus/db';
import { z } from 'zod';
import {
  handleHistory,
  identitySummary,
  linkSummary,
  personLabels,
  signalsOf,
} from '../identity-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });

export const identityRouter = router({
  /** Chips for a person (`personRecordId`), or the unresolved queue (`unresolved: true`). */
  list: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(
      z
        .object({
          personRecordId: z.string().uuid().optional(),
          unresolved: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.identity.findMany({
        where: {
          deletedAt: null,
          ...(input.personRecordId ? { personRecordId: input.personRecordId } : {}),
          ...(input.unresolved ? { personRecordId: null } : {}),
        },
        orderBy: { lastSeenAt: 'desc' },
        take: input.limit,
        include: {
          links: {
            where: { revokedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { confirmedBy: { select: { name: true, email: true } } },
          },
          _count: { select: { timelineEvents: true, conversations: true } },
          mergeSuggestions: {
            where: { status: 'PENDING' },
            select: { id: true, rightRecordId: true, score: true },
            take: 1,
          },
        },
      });
      const labels = await personLabels(
        ctx.db,
        rows.flatMap((r) => [
          ...(r.personRecordId ? [r.personRecordId] : []),
          ...r.mergeSuggestions.map((s) => s.rightRecordId),
        ]),
      );
      return rows.map((r) => ({
        ...identitySummary(r),
        person: r.personRecordId
          ? { id: r.personRecordId, label: labels.get(r.personRecordId)?.label ?? '(person)' }
          : null,
        link: r.links[0] ? linkSummary(r.links[0]) : null,
        events: r._count.timelineEvents,
        conversations: r._count.conversations,
        suggestion: r.mergeSuggestions[0]
          ? {
              id: r.mergeSuggestions[0].id,
              score: r.mergeSuggestions[0].score,
              person: {
                id: r.mergeSuggestions[0].rightRecordId,
                label: labels.get(r.mergeSuggestions[0].rightRecordId)?.label ?? '(person)',
              },
            }
          : null,
      }));
    }),

  get: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.identity.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          links: {
            orderBy: { createdAt: 'desc' },
            include: { confirmedBy: { select: { name: true, email: true } } },
          },
          mergeSuggestions: {
            where: { status: { in: ['PENDING', 'REJECTED'] } },
            orderBy: { updatedAt: 'desc' },
          },
          _count: { select: { timelineEvents: true, conversations: true } },
        },
      });
      if (!row) throw new NexusError('NOT_FOUND');
      const labels = await personLabels(ctx.db, [
        ...(row.personRecordId ? [row.personRecordId] : []),
        ...row.links.map((l) => l.personRecordId),
        ...row.mergeSuggestions.map((s) => s.rightRecordId),
      ]);
      return {
        ...identitySummary(row),
        person: row.personRecordId
          ? { id: row.personRecordId, label: labels.get(row.personRecordId)?.label ?? '(person)' }
          : null,
        links: row.links.map((l) => ({
          ...linkSummary(l),
          person: {
            id: l.personRecordId,
            label: labels.get(l.personRecordId)?.label ?? '(person)',
          },
        })),
        handleHistory: handleHistory(row.raw),
        suggestions: row.mergeSuggestions.map((s) => ({
          id: s.id,
          status: s.status,
          score: s.score,
          signals: signalsOf(s.signals),
          person: { id: s.rightRecordId, label: labels.get(s.rightRecordId)?.label ?? '(person)' },
        })),
        events: row._count.timelineEvents,
        conversations: row._count.conversations,
      };
    }),

  /** Live-scored people this identity could belong to, best first, with the evidence. */
  candidates: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.id, deletedAt: null },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      const subject = identitySubject(identity);
      const ids = await candidatePersonsForIdentity(ctx.db, ctx.workspace.id, identity);
      const labels = await personLabels(ctx.db, ids);
      const scored = [];
      for (const personRecordId of ids) {
        if (personRecordId === identity.personRecordId) continue;
        const ps = await personSubject(ctx.db, personRecordId, { excludeIdentityId: identity.id });
        if (!ps) continue;
        const score = scorePair(subject, ps);
        if (score.decision === 'none') continue;
        scored.push({
          person: { id: personRecordId, label: labels.get(personRecordId)?.label ?? '(person)' },
          score: score.score,
          decision: score.decision,
          method: score.method,
          signals: score.signals,
        });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, 5);
    }),

  /** A teammate says: this identity is that person. Confidence 1, method MANUAL, confirmed. */
  link: tenantProcedure
    .use(authorize('update', 'Identity'))
    .input(z.object({ identityId: z.string().uuid(), personRecordId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.identityId, deletedAt: null },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      const ps = await personSubject(ctx.db, input.personRecordId);
      if (!ps) throw new NexusError('NOT_FOUND');
      const score = scorePair(identitySubject(identity), ps);
      const r = await linkIdentity(ctx.db, ctx.actor, {
        identityId: identity.id,
        personRecordId: input.personRecordId,
        method: 'MANUAL',
        confidence: 1,
        evidence: {
          score: score.score,
          signals: score.signals,
          note: `Linked by ${ctx.session.name ?? ctx.session.email}`,
        },
        confirmed: true,
      });
      await ctx.audit({
        action: 'identity.linked',
        targetType: 'Identity',
        targetId: identity.id,
        diff: { personRecordId: input.personRecordId, backfilled: r.backfilled },
      });
      return r;
    }),

  unlink: tenantProcedure
    .use(authorize('update', 'Identity'))
    .input(z.object({ identityId: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.identityId, deletedAt: null },
        select: { id: true },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      const r = await unlinkIdentity(ctx.db, ctx.actor, {
        identityId: identity.id,
        reason: input.reason ?? null,
      });
      await ctx.audit({
        action: 'identity.unlinked',
        targetType: 'Identity',
        targetId: identity.id,
        diff: { personRecordId: r.personRecordId, reason: input.reason ?? null },
      });
      return r;
    }),

  createPerson: tenantProcedure
    .use(authorize('create', 'Record'))
    .input(z.object({ identityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.identityId, deletedAt: null },
        select: { id: true, personRecordId: true },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      if (identity.personRecordId)
        throw new NexusError('CONFLICT', {
          context: { reason: 'This identity already belongs to a person.' },
        });
      const r = await createPersonFromIdentity(ctx.db, ctx.actor, { identityId: identity.id });
      await ctx.audit({
        action: 'identity.person_created',
        targetType: 'Identity',
        targetId: identity.id,
        diff: { personRecordId: r.personRecordId },
      });
      return r;
    }),

  /** Run the resolver now (the nightly job does the same for every unresolved identity). */
  resolve: tenantProcedure
    .use(authorize('update', 'Identity'))
    .input(z.object({ identityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.identityId, deletedAt: null },
        select: { id: true },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      const r = await resolveIdentity(ctx.db, ctx.actor, { identityId: identity.id });
      await ctx.audit({
        action: 'identity.resolved',
        targetType: 'Identity',
        targetId: identity.id,
        diff: {
          action: r.action,
          ...('personRecordId' in r ? { personRecordId: r.personRecordId } : {}),
          ...('score' in r && r.score ? { score: r.score.score } : {}),
        },
      });
      return r;
    }),
});
