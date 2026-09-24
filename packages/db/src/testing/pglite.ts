/**
 * In-process Postgres for tests: PGlite (real Postgres compiled to WASM, with pgvector,
 * pg_trgm and citext) behind the Prisma 7 driver adapter. Applies every migration in
 * prisma/migrations in order, creates the non-superuser application role and switches to it,
 * so RLS is enforced exactly as in production. No Docker required.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '../generated/prisma/client.ts';
import { createTenantRuntime, type TenantRuntime } from '../scoped.ts';
import { createTenancy, type Tenancy } from '../tenancy.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '../../prisma/migrations');
export const APP_ROLE = 'nexus_app';

export type TestDatabase = {
  pglite: PGlite;
  /** Unscoped client, for test setup/assertions only. */
  prisma: PrismaClient;
  runtime: TenantRuntime;
  tenancy: Tenancy;
  /** Run raw SQL as the app role (RLS applies). */
  sql(text: string, params?: unknown[]): Promise<unknown[]>;
  /** Run raw SQL as superuser (RLS does not apply) — for assertions about what really exists. */
  sqlAsSuperuser(text: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
};

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = await PGlite.create({ extensions: { vector, pg_trgm, citext } });
  await pglite.exec(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;`);
  for (const m of migrationFiles()) {
    try {
      await pglite.exec(m.sql);
    } catch (e) {
      throw new Error(
        `migration ${m.name} failed on PGlite: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  await pglite.exec(`SET ROLE ${APP_ROLE};`);

  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
  const runtime = createTenantRuntime(prisma);
  return {
    pglite,
    prisma,
    runtime,
    tenancy: createTenancy(runtime),
    async sql(text, params = []) {
      return (await pglite.query(text, params)).rows;
    },
    async sqlAsSuperuser(text, params = []) {
      await pglite.exec('RESET ROLE;');
      try {
        return (await pglite.query(text, params)).rows;
      } finally {
        await pglite.exec(`SET ROLE ${APP_ROLE};`);
      }
    },
    async close() {
      await prisma.$disconnect();
      await pglite.close();
    },
  };
}
