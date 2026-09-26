/**
 * The workspace health console (§12.2.C): quota consumption per connection against its tier,
 * webhook delivery health, failed runs, tokens expiring soon, and drift — with a single
 * reassuring state when none of those need attention. Read-only: every mutation that fixes a
 * problem here (reconnect, replay, pause) already lives on `connection`/`webhookEvent`.
 */
import {
  expiringTokens,
  recentDriftSamples,
  recentFailedRuns,
  webhookHealthSummary,
} from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

export const healthRouter = router({
  summary: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(
      z
        .object({ expiringWithinDays: z.number().int().positive().default(30) })
        .default({ expiringWithinDays: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const since24h = new Date(Date.now() - 24 * 3600_000);
      const [connections, tokens, failedRuns, driftSamples, webhooks] = await Promise.all([
        ctx.db.connection.findMany({
          where: { deletedAt: null },
          select: { id: true, label: true, platform: true, status: true, settings: true },
        }),
        expiringTokens(ctx.db, input.expiringWithinDays),
        recentFailedRuns(ctx.db, { since: since24h }),
        recentDriftSamples(ctx.db, { since: new Date(Date.now() - 7 * 86_400_000) }),
        webhookHealthSummary(ctx.db, { since: since24h }),
      ]);

      const budgets = await Promise.all(
        connections.map(async (c) => {
          const connector = ctx.sync.registry.tryGet(c.platform);
          if (!connector) return null;
          const settings = c.settings as {
            spendCap?: Parameters<typeof ctx.sync.limiter.snapshot>[2];
          };
          const snapshot = await ctx.sync.limiter.snapshot(
            c.id,
            connector.manifest.quota,
            settings.spendCap ?? null,
          );
          return {
            connectionId: c.id,
            label: c.label,
            platform: c.platform,
            status: c.status,
            snapshot,
          };
        }),
      );

      const everythingFine =
        tokens.length === 0 &&
        failedRuns.length === 0 &&
        webhooks.rejected === 0 &&
        connections.every((c) => c.status === 'CONNECTED');

      return {
        everythingFine,
        connectionCount: connections.length,
        expiringTokens: tokens,
        failedRuns,
        driftSamples,
        webhooks,
        budgets: budgets.filter((b): b is NonNullable<typeof b> => b !== null),
      };
    }),
});
