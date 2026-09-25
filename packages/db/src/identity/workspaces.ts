/** Every workspace id, for cross-tenant housekeeping jobs (the nightly re-score). */
import type { TenantRuntime } from '../scoped.ts';

export async function listWorkspaceIds(runtime: TenantRuntime): Promise<string[]> {
  return runtime.withSystem(async (db) =>
    (await db.workspace.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })).map(
      (w) => w.id,
    ),
  );
}
