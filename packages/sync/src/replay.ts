/**
 * Replay (§4.1 "stages 3–7 are individually replayable per object and per connection", §9.2
 * "dead-letter queue with one-click replay"). Replaying from `normalize` clears the stamps on
 * the raw rows and re-queues them; the raw store is never touched, which is the whole point of
 * committing raw before interpretation.
 */
import { QUEUES } from '@nexus/config';
import { NexusError } from '@nexus/core';
import { markReplayed, systemActorFor } from '@nexus/db';
import type { SyncDeps } from './deps.ts';
import { JOB_NAMES, type NormalizeJob } from './jobs.ts';

export type ReplayStage = 'normalize' | 'materialize';

export async function replayConnection(
  deps: SyncDeps,
  input: {
    workspaceId: string;
    connectionId: string;
    fromStage: ReplayStage;
    since?: Date | null;
    kinds?: string[];
    batchSize?: number;
  },
): Promise<{ objects: number; jobs: number }> {
  const actor = systemActorFor(input.workspaceId, input.connectionId);
  const batch = input.batchSize ?? 200;
  const where = {
    connectionId: input.connectionId,
    deletedAt: null,
    ...(input.since ? { fetchedAt: { gte: input.since } } : {}),
    ...(input.kinds?.length ? { kind: { in: input.kinds } } : {}),
  };
  const ids = await deps.runtime.withTenant(actor, async (db) => {
    const rows = await db.externalObject.findMany({
      where,
      select: { id: true },
      orderBy: { fetchedAt: 'asc' },
    });
    if (input.fromStage === 'normalize' && rows.length) {
      await db.externalObject.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { normalizedAt: null, quarantinedAt: null },
      });
    }
    return rows.map((r) => r.id);
  });
  let jobs = 0;
  for (let i = 0; i < ids.length; i += batch) {
    const data: NormalizeJob & { force?: boolean } = {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      objectIds: ids.slice(i, i + batch),
      force: input.fromStage === 'materialize',
    };
    await deps.bus.enqueue({
      queue: QUEUES.normalize,
      name: JOB_NAMES.normalize,
      data,
      opts: { lane: 'backfill' },
    });
    jobs += 1;
  }
  return { objects: ids.length, jobs };
}

export async function replayDeadLetter(
  deps: SyncDeps,
  input: { workspaceId: string; id: string },
): Promise<{ jobId: string }> {
  const actor = systemActorFor(input.workspaceId);
  const row = await deps.runtime.withTenant(actor, (db) =>
    db.deadLetter.findUnique({ where: { id: input.id } }),
  );
  if (!row)
    throw new NexusError('NOT_FOUND', {
      message: 'dead letter not found',
      details: { id: input.id },
    });
  if (row.replayedAt)
    throw new NexusError('CONFLICT', {
      message: 'this dead letter was already replayed',
      details: { id: input.id, replayJobId: row.replayJobId },
    });
  const job = await deps.bus.enqueue({
    queue: row.queue as (typeof QUEUES)[keyof typeof QUEUES],
    name: row.jobName,
    data: row.payload,
    opts: { jobId: `replay:${row.id}:${Date.now()}` },
  });
  await deps.runtime.withTenant(actor, (db) => markReplayed(db, row.id, job.jobId));
  return { jobId: job.jobId };
}
