/**
 * Connections (spec §7.4, §9): list and inspect, pause/resume, sync now, per-connection
 * settings, runs and errors, dead letters with replay, disconnect & purge. Everything the
 * Phase 9 integrations hub renders; tokens are never returned (§5.4). Cross-connection
 * permission uses the per-connection CASL subject so grants apply.
 */
import { connectionSettingsSchema, PLATFORMS } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import {
  diffOf,
  getConnection,
  listDeadLetters,
  markReplayed,
  setConnectionStatus,
  updateConnectionSettings,
} from '@nexus/db';
import { buildAuthCtx, enqueueBackfill, enqueueDelta, startOauth } from '@nexus/sync';
import { z } from 'zod';
import { connection as connectionSubject } from '../abilities';
import { authorize, router, tenantProcedure } from '../trpc';

const id = z.object({ id: z.string().uuid() });

function publicConnection(c: NonNullable<Awaited<ReturnType<typeof getConnection>>>) {
  const { tokenRef: _t, webhookSecretRef: _w, ...rest } = c;
  return rest;
}

async function loadOrThrow(ctx: { db: Parameters<typeof getConnection>[0] }, connectionId: string) {
  const c = await getConnection(ctx.db, connectionId);
  if (!c) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
  return c;
}

export const connectionRouter = router({
  list: tenantProcedure.use(authorize('read', 'Connection')).query(async ({ ctx }) => {
    const rows = await ctx.db.connection.findMany({
      where: { deletedAt: null },
      orderBy: [{ platform: 'asc' }, { label: 'asc' }],
    });
    return rows.map((c) =>
      publicConnection({ ...c, settings: connectionSettingsSchema.parse(c.settings ?? {}) }),
    );
  }),

  get: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(id)
    .query(async ({ ctx, input }) => {
      const c = await loadOrThrow(ctx, input.id);
      const connector = ctx.sync.registry.tryGet(c.platform);
      const [runs, errors, snapshot] = await Promise.all([
        ctx.db.syncRun.findMany({
          where: { connectionId: c.id },
          orderBy: { startedAt: 'desc' },
          take: 20,
        }),
        ctx.db.integrationError.findMany({
          where: { connectionId: c.id, resolvedAt: null },
          orderBy: { occurredAt: 'desc' },
          take: 20,
        }),
        connector
          ? ctx.sync.limiter.snapshot(c.id, connector.manifest.quota, c.settings.spendCap)
          : Promise.resolve(null),
      ]);
      return {
        ...publicConnection(c),
        manifest: connector?.manifest ?? null,
        runs,
        errors,
        budget: snapshot,
      };
    }),

  /** Where the browser should go to start connecting a platform (the route sets the PKCE cookie). */
  connectUrl: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(
      z.object({ platform: z.enum(PLATFORMS), returnTo: z.string().startsWith('/').optional() }),
    )
    .query(({ ctx, input }) => {
      // Validates the platform is registered; the actual redirect happens in /api/connect/:platform/start.
      ctx.sync.registry.get(input.platform);
      const q = new URLSearchParams({
        workspace: ctx.workspace.slug,
        ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      });
      return {
        url: `${ctx.appUrl}/api/connect/${input.platform.toLowerCase()}/start?${q.toString()}`,
        preview: startOauth(ctx.sync, {
          workspaceId: ctx.workspace.id,
          userId: ctx.session.id,
          platform: input.platform,
        }).authorizeUrl,
      };
    }),

  updateSettings: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(z.object({ id: z.string().uuid(), settings: connectionSettingsSchema.partial() }))
    .mutation(async ({ ctx, input }) => {
      const before = await loadOrThrow(ctx, input.id);
      if (!ctx.ability.can('configure', connectionSubject(before.id)))
        throw new NexusError('FORBIDDEN');
      const next = await updateConnectionSettings(ctx.db, before.id, input.settings);
      await ctx.audit({
        action: 'connection.settings_changed',
        targetType: 'Connection',
        targetId: before.id,
        diff: diffOf(before.settings, next),
      });
      return next;
    }),

  pause: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id.extend({ reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadOrThrow(ctx, input.id);
      await setConnectionStatus(ctx.db, c.id, 'PAUSED', {
        pausedReason: input.reason ?? 'Paused by an administrator.',
      });
      await updateConnectionSettings(ctx.db, c.id, { paused: true });
      await ctx.audit({
        action: 'connection.paused',
        targetType: 'Connection',
        targetId: c.id,
        diff: { reason: input.reason ?? null },
      });
      return { id: c.id, status: 'PAUSED' as const };
    }),

  resume: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const c = await loadOrThrow(ctx, input.id);
      if (c.status === 'RECONNECT_REQUIRED' || c.status === 'REVOKED') {
        throw new NexusError('AUTH_EXPIRED', { context: { connectionLabel: c.label } });
      }
      await setConnectionStatus(ctx.db, c.id, 'CONNECTED', { pausedReason: null });
      await updateConnectionSettings(ctx.db, c.id, { paused: false });
      await ctx.audit({ action: 'connection.resumed', targetType: 'Connection', targetId: c.id });
      return { id: c.id, status: 'CONNECTED' as const };
    }),

  syncNow: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id.extend({ resource: z.string().optional(), backfill: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadOrThrow(ctx, input.id);
      const connector = ctx.sync.registry.get(c.platform);
      const resources = input.resource
        ? [input.resource]
        : connector.listResources().map((r) => r.id);
      const jobIds: string[] = [];
      if (input.backfill) {
        jobIds.push(
          ...(await enqueueBackfill(ctx.sync, {
            workspaceId: c.workspaceId,
            connectionId: c.id,
            platform: c.platform,
            resources,
          })),
        );
      } else {
        for (const r of resources)
          jobIds.push(
            await enqueueDelta(ctx.sync, {
              workspaceId: c.workspaceId,
              connectionId: c.id,
              platform: c.platform,
              resource: r,
              trigger: 'MANUAL',
            }),
          );
      }
      await ctx.audit({
        action: input.backfill ? 'connection.backfill_requested' : 'connection.sync_requested',
        targetType: 'Connection',
        targetId: c.id,
        diff: { resources, jobIds },
      });
      return { jobIds };
    }),

  runs: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(id.extend({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      await loadOrThrow(ctx, input.id);
      return ctx.db.syncRun.findMany({
        where: { connectionId: input.id },
        orderBy: { startedAt: 'desc' },
        take: input.limit,
      });
    }),

  errors: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(
      id.extend({
        includeResolved: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      await loadOrThrow(ctx, input.id);
      return ctx.db.integrationError.findMany({
        where: { connectionId: input.id, ...(input.includeResolved ? {} : { resolvedAt: null }) },
        orderBy: { occurredAt: 'desc' },
        take: input.limit,
      });
    }),

  resolveError: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.integrationError.findFirst({ where: { id: input.id } });
      if (!row) throw new NexusError('NOT_FOUND', { message: 'Error not found.' });
      await ctx.db.integrationError.update({
        where: { id: row.id },
        data: { resolvedAt: new Date(), resolvedById: ctx.session.id },
      });
      await ctx.audit({
        action: 'connection.error_resolved',
        targetType: 'IntegrationError',
        targetId: row.id,
      });
      return { id: row.id };
    }),

  deadLetters: tenantProcedure
    .use(authorize('read', 'Connection'))
    .input(
      z
        .object({
          connectionId: z.string().uuid().optional(),
          includeReplayed: z.boolean().default(false),
        })
        .default({ includeReplayed: false }),
    )
    .query(async ({ ctx, input }) => {
      return listDeadLetters(ctx.db, {
        connectionId: input.connectionId,
        includeReplayed: input.includeReplayed,
      });
    }),

  replayDeadLetter: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id)
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.deadLetter.findFirst({ where: { id: input.id } });
      if (!row) throw new NexusError('NOT_FOUND', { message: 'Dead letter not found.' });
      if (row.replayedAt)
        throw new NexusError('CONFLICT', { message: 'This dead letter was already replayed.' });
      // Same steps as @nexus/sync replayDeadLetter, on this procedure's transaction (no nesting).
      const job = await ctx.sync.bus.enqueue({
        queue: row.queue as 'sync.backfill',
        name: row.jobName,
        data: row.payload,
        opts: { jobId: `replay:${row.id}:${Date.now()}` },
      });
      await markReplayed(ctx.db, row.id, job.jobId);
      await ctx.audit({
        action: 'dead_letter.replayed',
        targetType: 'DeadLetter',
        targetId: row.id,
        diff: { jobId: job.jobId },
      });
      return { jobId: job.jobId };
    }),

  /** Disconnect & purge (§7.4): the platform token is revoked best-effort, the vault entries wiped, raw data soft-deleted. Requires the typed label. */
  disconnect: tenantProcedure
    .use(authorize('configure', 'Connection'))
    .input(id.extend({ confirmLabel: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const c = await loadOrThrow(ctx, input.id);
      if (input.confirmLabel !== c.label)
        throw new NexusError('VALIDATION', {
          message: 'Type the connection label exactly to confirm.',
        });
      const connector = ctx.sync.registry.tryGet(c.platform);
      if (connector) {
        try {
          const { token } = await ctx.sync.vault.getTokenSet(ctx.db, c.tokenRef);
          await connector.revoke(buildAuthCtx(ctx.sync, c.platform, c.workspaceId, c.id), token);
        } catch (e) {
          ctx.sync.logger.warn('platform-side revoke failed; continuing with local purge', {
            connectionId: c.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await ctx.sync.vault.revoke(ctx.db, c.tokenRef).catch(() => undefined);
      if (c.webhookSecretRef)
        await ctx.sync.vault.revoke(ctx.db, c.webhookSecretRef).catch(() => undefined);
      const now = new Date();
      await ctx.db.externalObject.updateMany({
        where: { connectionId: c.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await ctx.db.syncCursor.updateMany({
        where: { connectionId: c.id },
        data: { deletedAt: now },
      });
      await ctx.db.connection.update({
        where: { id: c.id },
        data: { status: 'REVOKED', deletedAt: now, pausedReason: 'Disconnected and purged.' },
      });
      await ctx.audit({
        action: 'connection.disconnected',
        targetType: 'Connection',
        targetId: c.id,
        diff: { platform: c.platform, accountExternalId: c.accountExternalId },
      });
      return { id: c.id, status: 'REVOKED' as const };
    }),
});
