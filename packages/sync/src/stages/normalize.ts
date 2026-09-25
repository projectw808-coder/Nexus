/**
 * Stage 3 (§4.1): the connector's pure `normalize()` over persisted raw rows. A shape the
 * connector refuses is SCHEMA_DRIFT: the raw row stays (it is the replay source of truth),
 * gets `quarantinedAt`, and an IntegrationError points at it for the raw viewer. Valid
 * entities go to the sink (stages 4–7) and the row is stamped `normalizedAt`.
 */
import { canonicalEntitySchema, type NormalizeCtx } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import { QUEUES } from '@nexus/config';
import { pendingNormalization, recordIntegrationError, systemActorFor } from '@nexus/db';
import { JOB_NAMES } from '../jobs.ts';
import { loadConnection } from '../context.ts';
import { nowOf, type SyncDeps } from '../deps.ts';
import type { NormalizeJob } from '../jobs.ts';
import type { NormalizedBatch } from '../sink.ts';

export type NormalizeOutcome = {
  normalized: number;
  quarantined: number;
  entities: number;
  skipped: number;
};

const REQUEUE_BATCH = 200;

/**
 * Re-queue every raw row that never reached stage 3 — rows a crashed worker persisted whose
 * normalize job died with its queue. Called after each sync and at worker startup, so the
 * guarantee "every persisted object is normalized" does not depend on queue durability.
 */
export async function requeuePendingNormalization(
  deps: SyncDeps,
  input: { workspaceId: string; connectionId: string; limit?: number },
): Promise<{ objects: number; jobs: number }> {
  const actor = systemActorFor(input.workspaceId, input.connectionId);
  // Ids only: even a large backlog is a few megabytes, and one pass must cover all of it.
  const rows = await deps.runtime.withTenant(actor, (db) =>
    pendingNormalization(db, input.connectionId, input.limit ?? 1_000_000),
  );
  let jobs = 0;
  for (let i = 0; i < rows.length; i += REQUEUE_BATCH) {
    await deps.bus.enqueue({
      queue: QUEUES.normalize,
      name: JOB_NAMES.normalize,
      data: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        objectIds: rows.slice(i, i + REQUEUE_BATCH).map((r) => r.id),
      },
      opts: { lane: 'backfill' },
    });
    jobs += 1;
  }
  return { objects: rows.length, jobs };
}

export async function normalizeObjects(
  deps: SyncDeps,
  input: NormalizeJob & { force?: boolean },
): Promise<NormalizeOutcome> {
  const connection = await loadConnection(deps, input.workspaceId, input.connectionId);
  const connector = deps.registry.get(connection.platform);
  const actor = systemActorFor(connection.workspaceId, connection.id);
  const sample = deps.validateSample ?? 1;

  const rows = await deps.runtime.withTenant(actor, (db) =>
    db.externalObject.findMany({
      where: {
        id: { in: input.objectIds },
        connectionId: connection.id,
        deletedAt: null,
        ...(input.force ? {} : { normalizedAt: null }),
      },
      select: {
        id: true,
        kind: true,
        externalId: true,
        raw: true,
        apiVersion: true,
        fetchedAt: true,
      },
    }),
  );
  const outcome: NormalizeOutcome = {
    normalized: 0,
    quarantined: 0,
    entities: 0,
    skipped: input.objectIds.length - rows.length,
  };
  if (rows.length === 0) return outcome;

  const batch: NormalizedBatch = {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    platform: connection.platform,
    items: [],
  };
  const quarantined: { id: string; error: NexusError }[] = [];

  for (const row of rows) {
    const nctx: NormalizeCtx = {
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
      platform: connection.platform,
      accountExternalId: connection.accountExternalId,
      apiVersion: row.apiVersion,
      fetchedAt: row.fetchedAt,
      fieldMapping: {},
    };
    try {
      const entities = connector.normalize(row.kind, row.raw, nctx);
      if (sample >= 1 || Math.random() < sample) {
        for (const e of entities) {
          const parsed = canonicalEntitySchema.safeParse(e);
          if (!parsed.success) {
            throw new NexusError('SCHEMA_DRIFT', {
              message: `normalize(${row.kind}) produced an invalid ${String((e as { kind?: unknown }).kind)}`,
              details: {
                issues: parsed.error.issues
                  .slice(0, 5)
                  .map((i) => `${i.path.join('.')}: ${i.message}`),
              },
            });
          }
        }
      }
      batch.items.push({ objectId: row.id, kind: row.kind, externalId: row.externalId, entities });
      outcome.entities += entities.length;
    } catch (e) {
      const err =
        e instanceof NexusError
          ? e
          : new NexusError('SCHEMA_DRIFT', {
              message: e instanceof Error ? e.message : String(e),
              details: { kind: row.kind },
              cause: e,
            });
      quarantined.push({
        id: row.id,
        error:
          err.code === 'SCHEMA_DRIFT'
            ? err
            : new NexusError('SCHEMA_DRIFT', {
                message: err.message,
                details: { kind: row.kind, ...err.details },
                cause: err,
              }),
      });
    }
  }

  if (batch.items.length) await deps.sink.materialize(batch);

  const now = nowOf(deps);
  await deps.runtime.withTenant(actor, async (db) => {
    if (batch.items.length) {
      await db.externalObject.updateMany({
        where: { id: { in: batch.items.map((i) => i.objectId) } },
        data: { normalizedAt: now, quarantinedAt: null },
      });
    }
    for (const q of quarantined) {
      await db.externalObject.update({ where: { id: q.id }, data: { quarantinedAt: now } });
      await recordIntegrationError(db, {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        externalObjectId: q.id,
        platform: connection.platform,
        error: q.error,
      });
    }
  });
  outcome.normalized = batch.items.length;
  outcome.quarantined = quarantined.length;
  if (quarantined.length)
    deps.logger.warn('objects quarantined as SCHEMA_DRIFT', {
      connectionId: connection.id,
      count: quarantined.length,
    });
  return outcome;
}
