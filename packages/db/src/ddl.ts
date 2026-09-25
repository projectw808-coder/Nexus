/**
 * Schema-changing statements for the generated-column index builder (§6.6). The application
 * role cannot ALTER tables, so DDL runs as the table owner:
 *  - postgres: a dedicated `pg` connection to DATABASE_ADMIN_URL, autocommit (so
 *    CREATE INDEX CONCURRENTLY is allowed);
 *  - pglite:   the single in-process session, temporarily `RESET ROLE`.
 *
 * @internal packages/db only.
 */
import type { PGlite } from '@electric-sql/pglite';

export type DdlRunner = {
  exec(sql: string): Promise<void>;
  /** Runs `CREATE INDEX CONCURRENTLY …` when the backend allows it, else a plain CREATE INDEX. */
  createIndex(name: string, table: string, definition: string): Promise<void>;
  close(): Promise<void>;
};

const g = globalThis as { __nexusPglite?: PGlite };

/** The PGlite instance behind the pglite:// backend, registered by pglite-dev / the test harness. */
export function registerPglite(instance: PGlite): void {
  g.__nexusPglite = instance;
}

/** The registered PGlite instance, or null on the pg backend. */
export function getRegisteredPglite(): PGlite | null {
  return g.__nexusPglite ?? null;
}

export async function createDdlRunner(): Promise<DdlRunner> {
  const pglite = g.__nexusPglite;
  if (pglite) {
    const asOwner = async (sql: string) => {
      await pglite.exec('RESET ROLE;');
      try {
        await pglite.exec(sql);
      } finally {
        await pglite.exec('SET ROLE nexus_app;');
      }
    };
    return {
      exec: asOwner,
      // PGlite runs every statement in an implicit transaction; CONCURRENTLY is not available.
      createIndex: (name, table, definition) =>
        asOwner(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${definition};`),
      close: async () => undefined,
    };
  }

  const url = process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) is required for DDL');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    exec: async (sql) => {
      await client.query(sql);
    },
    createIndex: async (name, table, definition) => {
      try {
        await client.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${definition};`,
        );
      } catch (e) {
        // A failed CONCURRENTLY build leaves an invalid index behind; drop it before retrying.
        await client.query(`DROP INDEX IF EXISTS ${name};`);
        throw e;
      }
    },
    close: () => client.end(),
  };
}
