/**
 * Writes src/generated-tenant-models.ts from the generated Prisma client.
 * Runs as the second half of `pnpm --filter @nexus/db generate`.
 *
 * Usage: tsx scripts/gen-tenant-models.ts [--check]
 *   --check  exit 1 instead of writing when the checked-in file is stale (CI).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  NON_TENANT_ALLOWLIST,
  OUTPUT_FILE,
  PACKAGE_ROOT,
  allModelNames,
  readRuntimeDataModel,
  renderGeneratedFile,
  tenantModelsFromDataModel,
} from './tenant-models-from-dmmf.ts';

const check = process.argv.includes('--check');

const dm = readRuntimeDataModel();
const tenant = tenantModelsFromDataModel(dm);
const tenantSet = new Set(tenant);
const unexpected = allModelNames(dm).filter(
  (m) => !tenantSet.has(m) && !NON_TENANT_ALLOWLIST.has(m),
);

if (unexpected.length > 0) {
  console.error(
    `gen-tenant-models: these models have no \`workspaceId\` and are not on NON_TENANT_ALLOWLIST: ` +
      unexpected.join(', ') +
      '\nEither add workspaceId (tenant data) or add them to the allowlist in scripts/tenant-models-from-dmmf.ts with a reason.',
  );
  process.exit(1);
}

const next = renderGeneratedFile(dm);
const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : null;
const rel = path.relative(PACKAGE_ROOT, OUTPUT_FILE);

if (current === next) {
  console.log(`gen-tenant-models: ${rel} is up to date (${tenant.length} tenant models).`);
} else if (check) {
  console.error(
    `gen-tenant-models: ${rel} is stale. Run \`pnpm --filter @nexus/db generate\` and commit the result.`,
  );
  process.exit(1);
} else {
  writeFileSync(OUTPUT_FILE, next, 'utf8');
  console.log(`gen-tenant-models: wrote ${rel} (${tenant.length} tenant models).`);
}
