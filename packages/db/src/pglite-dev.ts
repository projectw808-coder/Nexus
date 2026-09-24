/**
 * `pglite://<dir>` backend: PGlite persisted on disk with migrations applied on open and the
 * production role/RLS setup (see src/testing/pglite.ts for the ephemeral test variant).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { migrationFiles } from './testing/pglite.ts';

export const APP_ROLE = 'nexus_app';

export async function openPgliteAdapter(dir: string): Promise<PrismaPGlite> {
  const dataDir = path.resolve(dir);
  mkdirSync(dataDir, { recursive: true });
  const pglite = await PGlite.create({ dataDir, extensions: { vector, pg_trgm, citext } });

  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "_nexus_migrations" (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
  `);
  const applied = new Set(
    (await pglite.query<{ name: string }>('SELECT name FROM "_nexus_migrations"')).rows.map(
      (r) => r.name,
    ),
  );
  for (const m of migrationFiles()) {
    if (applied.has(m.name)) continue;
    await pglite.exec(m.sql);
    await pglite.query('INSERT INTO "_nexus_migrations" (name) VALUES ($1)', [m.name]);
  }
  await pglite.exec(`SET ROLE ${APP_ROLE};`);
  return new PrismaPGlite(pglite);
}
