/**
 * Seeds the e2e database (PGlite, single process — runs to completion before `next start`
 * opens the same directory). Idempotent: an already-seeded directory is left alone.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), '.data/e2e');
process.env['DATABASE_URL'] = `pglite://${DATA_DIR}`;

async function main(): Promise<void> {
  if (process.env['E2E_RESEED'] === '1') rmSync(DATA_DIR, { recursive: true, force: true });
  const [{ runtime }, { seedE2eWorkspace }] = await Promise.all([
    import('@nexus/db'),
    import('@nexus/db/testing'),
  ]);
  const r = await seedE2eWorkspace(runtime);
  console.warn(
    r.created
      ? `e2e seed: created workspace e2e with 100,000 widgets`
      : 'e2e seed: already present',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
