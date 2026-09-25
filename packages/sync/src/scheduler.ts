/**
 * What to poll, and when (§9.1): per connection, every enabled resource at its interval on
 * the delta lane; a backfill for a fresh connection on the backfill lane. The worker turns the
 * plan into BullMQ job schedulers; the CLI and tests enqueue directly.
 */
import { QUEUES } from '@nexus/config';
import type { Platform } from '@nexus/connector-sdk';
import { listSchedulableConnections } from '@nexus/db';
import type { SyncDeps } from './deps.ts';
import { JOB_NAMES, syncJobId, type SyncJob } from './jobs.ts';

export type PlannedPoll = {
  connectionId: string;
  workspaceId: string;
  platform: Platform;
  resource: string;
  intervalSeconds: number;
  job: SyncJob;
  jobId: string;
};

export async function planDeltaPolls(deps: SyncDeps): Promise<PlannedPoll[]> {
  const out: PlannedPoll[] = [];
  for (const c of await listSchedulableConnections(deps.runtime)) {
    const connector = deps.registry.tryGet(c.platform);
    if (!connector) continue;
    for (const r of connector.listResources()) {
      const setting = c.settings.resources[r.id];
      if (!(setting?.enabled ?? r.defaultEnabled)) continue;
      const job: SyncJob = {
        workspaceId: c.workspaceId,
        connectionId: c.id,
        resource: r.id,
        trigger: 'SCHEDULE',
        lane: 'delta',
      };
      out.push({
        connectionId: c.id,
        workspaceId: c.workspaceId,
        platform: c.platform,
        resource: r.id,
        intervalSeconds: setting?.intervalSeconds ?? r.defaultIntervalSeconds,
        job,
        jobId: syncJobId(job),
      });
    }
  }
  return out;
}

/** Queue the initial backfill for every backfill-capable, enabled resource of a connection. */
export async function enqueueBackfill(
  deps: SyncDeps,
  input: {
    workspaceId: string;
    connectionId: string;
    platform: Platform;
    resources?: string[];
    maxPages?: number;
  },
): Promise<string[]> {
  const connector = deps.registry.get(input.platform);
  const ids: string[] = [];
  for (const r of connector.listResources()) {
    if (!r.supportsBackfill) continue;
    if (input.resources && !input.resources.includes(r.id)) continue;
    const job: SyncJob = {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      resource: r.id,
      trigger: 'BACKFILL',
      lane: 'backfill',
      maxPages: input.maxPages,
    };
    const res = await deps.bus.enqueue({
      queue: QUEUES.syncBackfill,
      name: JOB_NAMES.sync,
      data: job,
      opts: { jobId: syncJobId(job), lane: 'backfill' },
    });
    ids.push(res.jobId);
  }
  return ids;
}

export async function enqueueDelta(
  deps: SyncDeps,
  input: {
    workspaceId: string;
    connectionId: string;
    platform: Platform;
    resource: string;
    trigger?: SyncJob['trigger'];
  },
): Promise<string> {
  const job: SyncJob = {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    resource: input.resource,
    trigger: input.trigger ?? 'MANUAL',
    lane: input.trigger === 'SCHEDULE' ? 'delta' : 'interactive',
  };
  const res = await deps.bus.enqueue({
    queue: QUEUES.syncDelta,
    name: JOB_NAMES.sync,
    data: job,
    opts: { jobId: `${syncJobId(job)}:${Date.now()}`, lane: job.lane },
  });
  return res.jobId;
}
