import { describe, expect, it } from 'vitest';
import { MODEL_META, TENANT_MODELS } from './generated-tenant-models.ts';
import { migrationFiles } from './testing/pglite.ts';

/**
 * A new tenant model cannot be forgotten: every table in TENANT_MODELS (plus Workspace) must
 * have its RLS policy somewhere in the migrations directory. When this fails, run
 * `pnpm --filter @nexus/db gen:rls -- --out prisma/migrations/<timestamp>_rls_policies/migration.sql`.
 */
describe('row-level security coverage', () => {
  const sql = migrationFiles()
    .map((m) => m.sql)
    .join('\n');

  it('has a policy for every tenant table and the tenant root', () => {
    const missing = [...TENANT_MODELS, 'Workspace']
      .map((m) => MODEL_META[m]?.table ?? m)
      .filter((table) => !sql.includes(`CREATE POLICY rls_${table}_tenant ON "${table}"`));
    expect(missing, `tables without an RLS policy: ${missing.join(', ')}`).toEqual([]);
  });

  it('forces RLS so the table owner is covered too', () => {
    for (const m of TENANT_MODELS) {
      const table = MODEL_META[m]?.table ?? m;
      expect(sql, table).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
  });
});
