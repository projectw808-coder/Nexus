/**
 * Stages 1–2 of the pipeline (§4.1): acquire a page from the connector and persist it raw,
 * committing the page, the cursor and the run counters in ONE transaction. A worker killed at
 * any instant therefore resumes from the last committed page with nothing lost and nothing
 * fetched twice beyond the page in flight — and the raw store's idempotent upsert absorbs
 * even that.
 */
import { QUEUES } from '@nexus/config';
import {
  isAbortError,
  nextDelayMs,
  rawPageSchema,
  type Lane,
  type ResourceRef,
} from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import {
  clearCursor,
  finishRun,
  loadCursor,
  persistRawItems,
  progressRun,
  saveCursor,
  setConnectionStatus,
  startRun,
  systemActorFor,
  touchConnectionSync,
} from '@nexus/db';
import { bindConnection } from '../context.ts';
import { nowOf, type SyncDeps } from '../deps.ts';
import { applyFailure, asNexusError } from '../failures.ts';
import { JOB_NAMES, syncJobId, type SyncJob } from '../jobs.ts';
import { requeuePendingNormalization } from './normalize.ts';

export type SyncOutcome =
  | {
      status: 'succeeded';
      runId: string;
      pages: number;
      fetched: number;
      created: number;
      updated: number;
      skipped: number;
      budgetSpent: number;
    }
  | {
      status: 'yielded';
      runId: string;
      pages: number;
      fetched: number;
      created: number;
      updated: number;
      skipped: number;
      budgetSpent: number;
      continuationJobId: string;
    }
  | { status: 'skipped'; reason: 'paused' | 'resource_disabled' | 'status' }
  | { status: 'failed'; runId: string; code: string; retry: boolean };

const NORMALIZE_BATCH = 200;

export async function runResourceSync(
  deps: SyncDeps,
  input: SyncJob & { signal?: AbortSignal; attempt?: number },
): Promise<SyncOutcome> {
  const lane: Lane = input.lane;
  const bound = await bindConnection(deps, {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    lane,
    signal: input.signal,
  });
  const { connection, connector, ctx, log } = bound;
  const actor = systemActorFor(connection.workspaceId, connection.id);

  if (connection.settings.paused || connection.status === 'PAUSED')
    return { status: 'skipped', reason: 'paused' };
  if (connection.status !== 'CONNECTED' && connection.status !== 'DEGRADED')
    return { status: 'skipped', reason: 'status' };
  const descriptor = connector.listResources().find((r) => r.id === input.resource);
  if (!descriptor)
    throw new NexusError('VALIDATION', {
      message: `${connection.platform} has no resource ${input.resource}`,
    });
  const enabled =
    connection.settings.resources[input.resource]?.enabled ?? descriptor.defaultEnabled;
  if (!enabled) return { status: 'skipped', reason: 'resource_disabled' };

  const cursorState = await deps.runtime.withTenant(actor, (db) =>
    loadCursor(db, connection.id, input.resource),
  );
  const runId = (
    await deps.runtime.withTenant(actor, (db) =>
      startRun(db, {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        resource: input.resource,
        trigger: input.trigger,
      }),
    )
  ).id;
  const now = nowOf(deps);
  const overlap =
    (cursorState?.overlapSeconds ??
      descriptor.overlapSeconds ??
      connection.settings.overlapSeconds) * 1000;
  const ref: ResourceRef = {
    id: input.resource,
    since:
      input.trigger === 'BACKFILL'
        ? new Date(now.getTime() - connection.settings.backfillDays * 86_400_000)
        : null,
    highWaterMark:
      input.trigger !== 'BACKFILL' && cursorState?.highWaterMark
        ? new Date(cursorState.highWaterMark.getTime() - overlap)
        : null,
  };
  // A leftover page cursor (interrupted run) resumes regardless of trigger.
  let cursor: string | undefined = cursorState?.cursor ?? undefined;
  const totals = { pages: 0, fetched: 0, created: 0, updated: 0, skipped: 0, budgetSpent: 0 };
  let versionWarned = false;

  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const page = rawPageSchema.parse(await connector.fetchPage(ctx, ref, cursor));
      if (page.servedApiVersion && page.servedApiVersion !== ctx.apiVersion && !versionWarned) {
        versionWarned = true;
        log.warn('served API version differs from the pinned version', {
          served: page.servedApiVersion,
          pinned: ctx.apiVersion,
        });
      }
      const persisted = await deps.runtime.withTenant(actor, async (db) => {
        const res = await persistRawItems(db, {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          platform: connection.platform,
          apiVersion: page.servedApiVersion ?? ctx.apiVersion,
          items: page.items.map((i) => ({
            kind: i.kind,
            externalId: i.externalId,
            parentExternalId: i.parentExternalId,
            raw: i.raw,
          })),
          fetchedAt: nowOf(deps),
        });
        await saveCursor(db, {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          resource: input.resource,
          cursor: page.nextCursor,
          highWaterMark: page.highWaterMark ?? undefined,
        });
        await progressRun(db, runId, {
          fetched: page.items.length,
          created: res.created.length,
          updated: res.updated.length,
          skipped: res.skipped,
          budgetSpent: page.budgetSpent,
        });
        return res;
      });
      totals.pages += 1;
      totals.fetched += page.items.length;
      totals.created += persisted.created.length;
      totals.updated += persisted.updated.length;
      totals.skipped += persisted.skipped;
      totals.budgetSpent += page.budgetSpent;

      const toNormalize = [...persisted.created, ...persisted.updated];
      for (let i = 0; i < toNormalize.length; i += NORMALIZE_BATCH) {
        await deps.bus.enqueue({
          queue: QUEUES.normalize,
          name: JOB_NAMES.normalize,
          data: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            objectIds: toNormalize.slice(i, i + NORMALIZE_BATCH),
          },
          opts: { lane },
        });
      }

      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
      if (input.maxPages && totals.pages >= input.maxPages) {
        // Yield: the cursor is committed; a continuation job picks it up so long backfills share the queue fairly.
        await deps.runtime.withTenant(actor, (db) => finishRun(db, runId, { status: 'SUCCEEDED' }));
        const continuation = await deps.bus.enqueue({
          queue: input.trigger === 'BACKFILL' ? QUEUES.syncBackfill : QUEUES.syncDelta,
          name: JOB_NAMES.sync,
          data: continuationOf(input),
          opts: { jobId: `${syncJobId(input)}:${Date.now()}`, lane },
        });
        log.info('sync yielded after maxPages', {
          runId,
          pages: totals.pages,
          continuationJobId: continuation.jobId,
        });
        return { status: 'yielded', runId, ...totals, continuationJobId: continuation.jobId };
      }
    }

    await deps.runtime.withTenant(actor, async (db) => {
      await clearCursor(db, connection.id, input.resource);
      await finishRun(db, runId, { status: 'SUCCEEDED' });
      await touchConnectionSync(db, connection.id, { success: true });
      if (connection.status === 'DEGRADED')
        await setConnectionStatus(db, connection.id, 'CONNECTED', {
          healthScore: Math.min(100, connection.healthScore + 10),
        });
    });
    // Rows persisted by an earlier, killed worker may still lack their normalize job.
    await requeuePendingNormalization(deps, {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
    });
    log.info('sync finished', { runId, resource: input.resource, ...totals });
    return { status: 'succeeded', runId, ...totals };
  } catch (e) {
    if (isAbortError(e) || ctx.signal.aborted) {
      // Killed mid-run: the cursor of every committed page is already saved; nothing else to do.
      await deps.runtime
        .withTenant(actor, (db) => finishRun(db, runId, { status: 'CANCELLED' }))
        .catch(() => undefined);
      log.warn('sync aborted; will resume from the last committed page', {
        runId,
        pages: totals.pages,
      });
      throw e;
    }
    const outcome = await applyFailure(deps, { connection, error: e, syncRunId: runId });
    await deps.runtime.withTenant(actor, async (db) => {
      await finishRun(db, runId, { status: 'FAILED', error: outcome.error });
      await touchConnectionSync(db, connection.id, { success: false });
    });
    log.warn('sync failed', {
      runId,
      code: outcome.error.code,
      behaviour: outcome.behaviour,
      retry: outcome.retry,
      attempt: input.attempt ?? 0,
      pages: totals.pages,
    });
    if (outcome.retry && totals.pages > 0) {
      // Progress was committed: continue from the saved cursor as a new job after the backoff, so a
      // long backfill is never dead-lettered for transient faults spread over its lifetime. A job
      // that makes NO progress keeps its attempt count and dead-letters after the retry budget.
      const delayMs = nextDelayMs(input.attempt ?? 0, outcome.error, {
        baseMs: deps.httpRetry?.baseMs ?? 1_000,
        capMs: 60_000,
      });
      await deps.bus.enqueue({
        queue: input.trigger === 'BACKFILL' ? QUEUES.syncBackfill : QUEUES.syncDelta,
        name: JOB_NAMES.sync,
        data: continuationOf(input),
        opts: { jobId: `${syncJobId(input)}:${Date.now()}`, lane, delayMs },
      });
      return { status: 'failed', runId, code: outcome.error.code, retry: true };
    }
    if (outcome.retry) throw outcome.error; // the bus applies backoff, then dead-letters
    return { status: 'failed', runId, code: outcome.error.code, retry: false };
  }
}

/** The queue payload for the next leg of the same sync (no signal, no attempt counter). */
function continuationOf(input: SyncJob): SyncJob {
  return {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    resource: input.resource,
    trigger: input.trigger,
    lane: input.lane,
    maxPages: input.maxPages,
  };
}

export function classifyForRun(e: unknown): NexusError {
  return asNexusError(e);
}
