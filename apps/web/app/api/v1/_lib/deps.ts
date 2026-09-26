/**
 * What a REST v1 route handler needs from the process: the tenant runtime (ADR-006) and the
 * sync engine handle (Phase 4). Both are process-wide singletons in production; the override
 * exists so the route handlers can be driven against a PGlite database in tests exactly as
 * Next.js drives them in production (ADR-008 — no Docker, and no second copy of the handlers).
 */
import { runtime } from '@nexus/db';
import type { TenantRuntime } from '@nexus/db';
import type { SyncDeps } from '@nexus/sync';
import { createDispatcher, type JobDispatcher } from '@/server/jobs';
import { getSyncDeps } from '@/server/sync';

export type RestDeps = { runtime: TenantRuntime; sync: SyncDeps; jobs: JobDispatcher };

let override: RestDeps | null = null;

/** Test seam. Pass null to restore the process-wide deps. */
export function setRestDeps(deps: RestDeps | null): void {
  override = deps;
}

export async function getRestDeps(): Promise<RestDeps> {
  if (override) return override;
  return { runtime, sync: await getSyncDeps(), jobs: createDispatcher() };
}
