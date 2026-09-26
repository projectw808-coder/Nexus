/**
 * `pnpm --filter @nexus/db seed` (defaults to --demo) or `pnpm --filter @nexus/db seed -- --empty`.
 * Appendix B. The real implementation lives in `src/seed/` — this is just the CLI entry Prisma's
 * `migrations.seed` hook (see prisma.config.ts) and `package.json`'s "seed" script both invoke.
 *
 * Also seeds the only globally-seeded table in the product, `PlatformComplianceNote` (§5.5) — the
 * operator-maintained record of each platform's own terms constraints. It has no `workspaceId`,
 * so it doesn't belong in either workspace seed; the upsert is idempotent on `(platform, key)`,
 * and the worker runs the same function on boot.
 */
import { runtime, seedPlatformComplianceNotes } from '../src/index.ts';
import { seedDemo, seedEmpty } from '../src/seed/index.ts';

async function main() {
  const notes = await seedPlatformComplianceNotes(runtime);
  console.log(`seed: platform compliance notes — ${notes.created} created, ${notes.updated} updated`);

  const empty = process.argv.includes('--empty');
  if (empty) {
    const { acmeId, globexId } = await seedEmpty();
    console.log(
      `seed --empty: workspaces ${acmeId} (acme-demo), ${globexId} (globex-demo); no content.`,
    );
    return;
  }
  await seedDemo();
  console.log('seed --demo: acme-demo populated per Appendix B; globex-demo left empty.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
