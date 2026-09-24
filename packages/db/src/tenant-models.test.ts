import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NON_TENANT_ALLOWLIST,
  SCHEMA_FILE,
  allModelNames,
  allModelsFromSchemaText,
  readRuntimeDataModel,
  renderGeneratedFile,
  tenantModelsFromDataModel,
  tenantModelsFromSchemaText,
} from '../scripts/tenant-models-from-dmmf.ts';
import { TENANT_MODELS } from './generated-tenant-models.ts';

const STALE_HINT =
  'src/generated-tenant-models.ts is stale — run `pnpm --filter @nexus/db generate` and commit it.';

describe('TENANT_MODELS', () => {
  const dm = readRuntimeDataModel();
  const fromDmmf = tenantModelsFromDataModel(dm);
  const schemaText = readFileSync(SCHEMA_FILE, 'utf8');
  const fromSchema = tenantModelsFromSchemaText(schemaText);
  const checkedIn = [...TENANT_MODELS].sort();

  it('matches the models with a workspaceId field in the generated client (DMMF)', () => {
    expect(checkedIn, STALE_HINT).toEqual(fromDmmf);
  });

  it('matches an independent parse of schema.prisma', () => {
    expect(checkedIn, STALE_HINT).toEqual(fromSchema);
  });

  it('is byte-for-byte what the generator would write', () => {
    const onDisk = readFileSync(new URL('./generated-tenant-models.ts', import.meta.url), 'utf8');
    expect(onDisk, STALE_HINT).toBe(renderGeneratedFile(dm));
  });

  it('every model without workspaceId is on the explicit non-tenant allowlist', () => {
    const tenant = new Set(fromDmmf);
    const unexpected = allModelNames(dm).filter(
      (m) => !tenant.has(m) && !NON_TENANT_ALLOWLIST.has(m),
    );
    expect(
      unexpected,
      'These models have no workspaceId and are not allowlisted in scripts/tenant-models-from-dmmf.ts: ' +
        unexpected.join(', '),
    ).toEqual([]);
  });

  it('the non-tenant allowlist contains only models that exist and lack workspaceId', () => {
    const all = new Set(allModelNames(dm));
    const tenant = new Set(fromDmmf);
    for (const name of NON_TENANT_ALLOWLIST) {
      expect(all.has(name), `${name} is allowlisted but not in the schema`).toBe(true);
      expect(tenant.has(name), `${name} is allowlisted but has a workspaceId field`).toBe(false);
    }
  });

  it('the generated client and schema.prisma agree on the model list', () => {
    expect(allModelNames(dm).sort()).toEqual(allModelsFromSchemaText(schemaText).sort());
  });

  it('never includes the tenant root', () => {
    expect(TENANT_MODELS.has('Workspace')).toBe(false);
  });
});
