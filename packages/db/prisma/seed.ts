/**
 * `pnpm --filter @nexus/db seed` (defaults to --demo) or `pnpm --filter @nexus/db seed -- --empty`.
 * Appendix B. The real implementation lives in `src/seed/` — this is just the CLI entry Prisma's
 * `migrations.seed` hook (see prisma.config.ts) and `package.json`'s "seed" script both invoke.
 */
import { seedDemo, seedEmpty } from '../src/seed/index.ts';

async function main() {
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
