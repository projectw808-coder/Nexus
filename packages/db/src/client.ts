import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. @nexus/db cannot construct the Prisma client without it — ' +
        'copy .env.example to .env or export DATABASE_URL (e.g. postgresql://nexus:nexus@localhost:5432/nexus).',
    );
  }
  return url;
}

/**
 * The unscoped Prisma client. It bypasses tenant isolation.
 *
 * @internal never import outside packages/db or apps/worker/src/system
 *
 * Everything else goes through `withTenant(actor, fn)` / `scopedDb(actor)`
 * (src/scoped.ts, Phase 1), which wraps this client in a transaction that has
 * issued `SET LOCAL app.workspace_id` and rewrites every query on a
 * TENANT_MODELS model to carry the actor's workspaceId. An ESLint rule bans
 * this import path elsewhere.
 */
export const basePrisma: PrismaClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireDatabaseUrl() }),
});
