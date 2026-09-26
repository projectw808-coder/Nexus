/**
 * Phase 11 — the compliance jobs (§5.5, ADR-022): the nightly retention purge and DSAR
 * processing (export and erasure).
 *
 * These ride on the `system` queue rather than getting one of their own. `QUEUES.system` is
 * already "housekeeping and diagnostics: token refresh, purge, drift samples" — a retention
 * purge is literally that, and a DSAR is a handful of jobs a year per workspace, not a lane that
 * needs its own concurrency. The file follows the Phase 10 `ai.ts`/`automation.ts` shape (its own
 * module, its own job-name map, its own scheduler registration) so `index.ts` stays a wiring
 * file, while `sync.ts` shows the precedent for a module that contributes names to the shared
 * `system` worker instead of owning a worker.
 *
 * Schedules:
 *  - `retention.purge` runs DAILY, not hourly. A retention policy is expressed in days, so
 *    sweeping 24 times per day only means 23 scans that find nothing; the one-day granularity of
 *    `retentionDays` is the resolution of the promise being kept.
 *  - `dsr.process` is NOT scheduled. It is enqueued the moment the request row is created
 *    (`dataSubjectRequest.create` → `ctx.jobs.dispatch('dsr.process', …)`), because a person
 *    filing a request should not wait for a sweep.
 */
import {
  purgeConnectionRetention,
  runDataSubjectRequest,
  runtime,
  seedPlatformComplianceNotes,
} from '@nexus/db';
import type { Logger } from '@nexus/telemetry';
import type { Queue } from 'bullmq';
import { z } from 'zod';

export const COMPLIANCE_SYSTEM_JOBS = {
  retentionPurge: 'retention.purge',
  dsr: 'dsr.process',
} as const;

export const COMPLIANCE_JOB_NAMES = new Set<string>(Object.values(COMPLIANCE_SYSTEM_JOBS));

const dsrJobSchema = z.object({
  workspaceId: z.string().min(1),
  requestId: z.string().min(1),
});

export async function handleComplianceJob(
  name: string,
  data: unknown,
  log: Logger,
): Promise<unknown> {
  switch (name) {
    case COMPLIANCE_SYSTEM_JOBS.retentionPurge: {
      const result = await purgeConnectionRetention(runtime);
      if (result.purged.length > 0) {
        log.info(
          {
            scanned: result.scanned,
            connections: result.purged.length,
            rows: result.purged.reduce((n, p) => n + p.total, 0),
          },
          'retention purge removed expired rows',
        );
      }
      return result;
    }
    case COMPLIANCE_SYSTEM_JOBS.dsr: {
      const input = dsrJobSchema.parse(data);
      const result = await runDataSubjectRequest(runtime, input);
      log.info(
        { requestId: result.requestId, kind: result.kind, status: result.status },
        'data subject request processed',
      );
      return result;
    }
    default:
      throw new Error(`unknown compliance job: ${name}`);
  }
}

/**
 * Register the daily purge and make sure the operator-maintained `PlatformComplianceNote` rows
 * exist. The seed is idempotent on `(platform, key)`, so running it on every boot keeps the
 * notes in step with the code that defines them without a migration.
 */
export async function scheduleComplianceJobs(system: Queue, log: Logger): Promise<void> {
  await system.upsertJobScheduler(
    COMPLIANCE_SYSTEM_JOBS.retentionPurge,
    { every: 24 * 60 * 60 * 1000 },
    { name: COMPLIANCE_SYSTEM_JOBS.retentionPurge, data: {} },
  );
  const notes = await seedPlatformComplianceNotes(runtime);
  log.debug(notes, 'platform compliance notes synced');
}
