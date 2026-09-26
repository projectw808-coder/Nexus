/**
 * Consent tracking (§5.5, ADR-022 decision 3). The gate itself lives in `@nexus/automation`'s
 * unprompted sends; this router is how a human sees and changes what the gate reads.
 */
import { NexusError } from '@nexus/core';
import {
  ConsentStatus,
  Platform,
  consentCounts,
  listConsent,
  listConsentForIdentity,
  recordConsent,
} from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const statusEnum = z.enum(Object.values(ConsentStatus) as [ConsentStatus, ...ConsentStatus[]]);
/** A `Platform` name, or one of the non-platform channels. */
const channelSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(
    (c) => (Object.values(Platform) as string[]).includes(c) || c === 'email' || c === 'sms',
    'Unknown channel.',
  );

export const consentRouter = router({
  /** Workspace-wide view for the settings screen: withdrawals first, filterable by channel. */
  list: tenantProcedure
    .use(authorize('read', 'ConsentRecord'))
    .input(
      z
        .object({
          channel: channelSchema.optional(),
          status: statusEnum.optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const [rows, counts] = await Promise.all([listConsent(ctx.db, input), consentCounts(ctx.db)]);
      return {
        rows: rows.map((r) => ({
          id: r.id,
          identityId: r.identityId,
          channel: r.channel,
          status: r.status,
          source: r.source,
          capturedAt: r.capturedAt,
          identity: r.identity,
        })),
        counts,
      };
    }),

  /** Every channel we hold a consent row for on one identity (the identity detail panel). */
  forIdentity: tenantProcedure
    .use(authorize('read', 'ConsentRecord'))
    .input(z.object({ identityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => listConsentForIdentity(ctx.db, input.identityId)),

  /** Set or withdraw consent by hand. Writes an audit row inside the same transaction. */
  record: tenantProcedure
    .use(authorize('update', 'ConsentRecord'))
    .input(
      z.object({
        identityId: z.string().uuid(),
        channel: channelSchema,
        status: statusEnum,
        source: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const identity = await ctx.db.identity.findFirst({
        where: { id: input.identityId, deletedAt: null },
        select: { id: true },
      });
      if (!identity) throw new NexusError('NOT_FOUND');
      // `recordConsent` writes the audit row through the sink we hand it, so there is exactly
      // one row and `tenantProcedure`'s "every mutation audits" guard is satisfied by it.
      return recordConsent(ctx.db, ctx.actor, input, ctx.audit);
    }),
});
