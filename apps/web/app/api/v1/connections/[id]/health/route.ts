/**
 * `GET /v1/connections/{id}/health` (§11.2) — what the workspace health console (`health.summary`,
 * §12.2.C) computes, narrowed to one connection: the live budget snapshot, webhook delivery
 * health, failed runs in the last 24h, unresolved errors, drift and token expiry.
 */
import { NexusError } from '@nexus/core';
import { restRoute } from '../../../_lib/handler';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 3600_000;
const EXPIRING_SOON_DAYS = 30;

export const GET = restRoute<{ id: string }>('READ', async (ctx, params) => {
  const since24h = new Date(Date.now() - DAY_MS);
  const data = await ctx.withTenant(async (db) => {
    const c = await db.connection.findFirst({
      where: { id: params.id, deletedAt: null },
      select: {
        id: true,
        label: true,
        platform: true,
        status: true,
        settings: true,
        tokenExpiresAt: true,
      },
    });
    if (!c) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
    const [failedRuns, openErrors, webhookRows, drift] = await Promise.all([
      db.syncRun.count({
        where: { connectionId: c.id, status: 'FAILED', startedAt: { gte: since24h } },
      }),
      db.integrationError.count({ where: { connectionId: c.id, resolvedAt: null } }),
      db.webhookEvent.findMany({
        where: { connectionId: c.id, receivedAt: { gte: since24h } },
        select: { verified: true, processedAt: true },
      }),
      db.connectionDriftSample.findFirst({
        where: { connectionId: c.id },
        orderBy: { sampledAt: 'desc' },
        select: { driftCount: true },
      }),
    ]);
    return { c, failedRuns, openErrors, webhookRows, drift };
  });

  const { c, failedRuns, openErrors, webhookRows, drift } = data;
  const connector = ctx.deps.sync.registry.tryGet(c.platform);
  const settings = c.settings as {
    spendCap?: Parameters<typeof ctx.deps.sync.limiter.snapshot>[2];
  };
  const budget = connector
    ? await ctx.deps.sync.limiter.snapshot(
        c.id,
        connector.manifest.quota,
        settings.spendCap ?? null,
      )
    : null;

  const rejected = webhookRows.filter((w) => !w.verified).length;
  const unprocessed = webhookRows.filter((w) => w.verified && !w.processedAt).length;
  const tokenExpiringSoon =
    c.tokenExpiresAt !== null &&
    c.tokenExpiresAt.getTime() - Date.now() < EXPIRING_SOON_DAYS * DAY_MS;

  return {
    body: {
      connectionId: c.id,
      label: c.label,
      platform: c.platform,
      status: c.status,
      everythingFine:
        c.status === 'CONNECTED' &&
        failedRuns === 0 &&
        openErrors === 0 &&
        rejected === 0 &&
        !tokenExpiringSoon,
      budget,
      tokenExpiresAt: c.tokenExpiresAt,
      tokenExpiringSoon,
      failedRuns24h: failedRuns,
      openErrors,
      webhooks: { received: webhookRows.length, rejected, unprocessed },
      driftCount: drift?.driftCount ?? null,
    },
  };
});
