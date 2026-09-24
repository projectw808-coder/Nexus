/**
 * The unscoped Prisma client. It bypasses tenant isolation.
 *
 * @internal never import outside packages/db or apps/worker/src/system
 *
 * Everything else goes through `withTenant(actor, fn)` (src/scoped.ts), which wraps this client
 * in a transaction that has issued `SET LOCAL app.workspace_id` and rewrites every query on a
 * TENANT_MODELS model to carry the actor's workspaceId. An ESLint rule bans this import path
 * elsewhere.
 *
 * Two backends, chosen by DATABASE_URL:
 *  - `postgresql://…`  — the `pg` driver adapter (docker-compose, CI, production).
 *  - `pglite://<dir>`  — in-process Postgres (PGlite) persisted in <dir>, for a Docker-free
 *    developer machine. Migrations are applied on first open; the app role and RLS are set up
 *    exactly as in production so nothing behaves differently later. Single process only.
 */
import { PrismaClient } from './generated/prisma/client.ts';

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. @nexus/db cannot construct the Prisma client without it — ' +
        'copy .env.example to .env or export DATABASE_URL (e.g. postgresql://nexus_app:nexus_app@localhost:5432/nexus, or pglite://./.data/nexus).',
    );
  }
  return url;
}

async function createClient(): Promise<PrismaClient> {
  const url = requireDatabaseUrl();
  if (url.startsWith('pglite://')) {
    const { openPgliteAdapter } = await import('./pglite-dev.ts');
    return new PrismaClient({ adapter: await openPgliteAdapter(url.slice('pglite://'.length)) });
  }
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

// Kept on globalThis so bundlers that evaluate this module in more than one module graph
// (Next.js RSC vs route handlers, dev HMR) still share one client — and one PGlite data dir.
const g = globalThis as { __nexusPrismaClient?: Promise<PrismaClient> };

/** Resolve the process-wide client (created on first use). */
export function getBasePrisma(): Promise<PrismaClient> {
  g.__nexusPrismaClient ??= createClient();
  return g.__nexusPrismaClient;
}
