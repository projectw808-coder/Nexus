/**
 * Derives the set of tenant-scoped models from the Prisma data model.
 *
 * Prisma 7's `prisma-client` generator no longer exposes `Prisma.dmmf`. What it
 * does emit is the DMMF datamodel subset the runtime needs — `RuntimeDataModel`
 * (models → fields with name/kind/type) — inlined into
 * `src/generated/prisma/internal/class.ts` as
 * `config.runtimeDataModel = JSON.parse("…")`. We read that literal back; it is
 * exactly what `Prisma.dmmf.datamodel.models` used to be, minus doc strings.
 *
 * A model is tenant-scoped iff it has a field named `workspaceId`. That is the
 * only rule, so a new model cannot be forgotten by the scoped client: either it
 * carries workspaceId and is automatically scoped, or it is missing it and the
 * test in src/tenant-models.test.ts fails unless it is on the explicit
 * NON_TENANT_ALLOWLIST.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeDataModel } from '@prisma/client/runtime/client';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const GENERATED_CLASS_FILE = path.join(
  PACKAGE_ROOT,
  'src',
  'generated',
  'prisma',
  'internal',
  'class.ts',
);
export const SCHEMA_FILE = path.join(PACKAGE_ROOT, 'prisma', 'schema.prisma');
export const OUTPUT_FILE = path.join(PACKAGE_ROOT, 'src', 'generated-tenant-models.ts');

export const TENANT_FIELD = 'workspaceId';

/**
 * Models that deliberately have no `workspaceId`. Anything else without one is
 * a bug. Workspace is the tenant root (scoped by `id`, handled explicitly in
 * the scoped client); User + Auth.js tables are cross-workspace by design;
 * PlatformComplianceNote is operator-maintained reference content (ADR-004).
 */
export const NON_TENANT_ALLOWLIST: ReadonlySet<string> = new Set([
  'Workspace',
  'User',
  'Account',
  'Session',
  'VerificationToken',
  'PlatformComplianceNote',
]);

const RUNTIME_DATA_MODEL_RE = /config\.runtimeDataModel\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/;

/** Reads the RuntimeDataModel literal out of the generated client. */
export function readRuntimeDataModel(file: string = GENERATED_CLASS_FILE): RuntimeDataModel {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `Generated Prisma client not found at ${file}. Run \`pnpm --filter @nexus/db generate\` first.`,
    );
  }
  const match = RUNTIME_DATA_MODEL_RE.exec(text);
  if (!match?.[1]) {
    throw new Error(
      `Could not find \`config.runtimeDataModel = JSON.parse("…")\` in ${file}. ` +
        'The prisma-client generator output changed; update scripts/tenant-models-from-dmmf.ts.',
    );
  }
  // match[1] is a JS double-quoted string literal produced by JSON.stringify,
  // so JSON.parse decodes the literal, and a second JSON.parse decodes the model.
  const json = JSON.parse(match[1]) as string;
  return JSON.parse(json) as RuntimeDataModel;
}

/** All model names in the data model, in declaration order. */
export function allModelNames(dm: RuntimeDataModel): string[] {
  return Object.keys(dm.models);
}

/** Model names that carry a `workspaceId` field, sorted. */
export function tenantModelsFromDataModel(dm: RuntimeDataModel): string[] {
  return Object.entries(dm.models)
    .filter(([, model]) => model.fields.some((f) => f.name === TENANT_FIELD))
    .map(([name]) => name)
    .sort();
}

/**
 * Independent cross-check that does not depend on the generated client: a
 * minimal parse of schema.prisma itself. Returns the same sorted list as
 * tenantModelsFromDataModel when everything is in sync.
 */
export function tenantModelsFromSchemaText(schemaText: string): string[] {
  const out: string[] = [];
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const m of schemaText.matchAll(modelRe)) {
    const name = m[1];
    const body = m[2] ?? '';
    const hasField = body.split('\n').some((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('@@')) return false;
      return trimmed.split(/\s+/)[0] === TENANT_FIELD;
    });
    if (name && hasField) out.push(name);
  }
  return out.sort();
}

export function allModelsFromSchemaText(schemaText: string): string[] {
  return [...schemaText.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!).filter(Boolean);
}

/** Relation fields per model, as the scoped client needs them (§5.3 nested traversal). */
export type RelationMeta = { model: string; isList: boolean };
export type ModelMeta = { table: string; relations: Record<string, RelationMeta> };

/**
 * `Model.field` keys of every list-typed field (`Type[]`). The runtime data model does not
 * record list-ness, so it is read from schema.prisma, which the generator validates against
 * the data model anyway (same model set).
 */
export function listFieldsFromSchemaText(schemaText: string): Set<string> {
  const out = new Set<string>();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const m of schemaText.matchAll(modelRe)) {
    const name = m[1];
    for (const line of (m[2] ?? '').split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('//') || t.startsWith('@@')) continue;
      const [field, type] = t.split(/\s+/);
      if (field && type && type.endsWith('[]')) out.add(`${name}.${field}`);
    }
  }
  return out;
}

export function modelMetaFromDataModel(
  dm: RuntimeDataModel,
  schemaText: string = readFileSync(SCHEMA_FILE, 'utf8'),
): Record<string, ModelMeta> {
  const lists = listFieldsFromSchemaText(schemaText);
  const out: Record<string, ModelMeta> = {};
  for (const [name, model] of Object.entries(dm.models).sort(([a], [b]) => a.localeCompare(b))) {
    const relations: Record<string, RelationMeta> = {};
    for (const f of model.fields) {
      if (f.kind === 'object') {
        relations[f.name] = { model: f.type, isList: lists.has(`${name}.${f.name}`) };
      }
    }
    out[name] = { table: model.dbName ?? name, relations };
  }
  return out;
}

/** Renders the checked-in generated file. */
export function renderGeneratedFile(dm: RuntimeDataModel): string {
  const tenantModels = tenantModelsFromDataModel(dm);
  const lines = tenantModels.map((name) => `  '${name}',`).join('\n');
  const meta = modelMetaFromDataModel(dm);
  const metaLines = Object.entries(meta)
    .map(([name, m]) => {
      const rels = Object.entries(m.relations)
        .map(([f, r]) => `${f}: { model: '${r.model}', isList: ${r.isList} }`)
        .join(', ');
      return `  ${name}: { table: '${m.table}', relations: { ${rels} } },`;
    })
    .join('\n');
  return `// GENERATED FILE — DO NOT EDIT.
// Produced by scripts/gen-tenant-models.ts from the Prisma runtime data model
// (every model that has a \`workspaceId\` field, plus relation metadata for the
// scoped client's nested traversal). Regenerate with:
//   pnpm --filter @nexus/db generate
// src/tenant-models.test.ts fails if this file is stale.

export const TENANT_MODELS: ReadonlySet<string> = new Set([
${lines}
]);

export type RelationMeta = { model: string; isList: boolean };
export type ModelMeta = { table: string; relations: Record<string, RelationMeta> };

export const MODEL_META: Readonly<Record<string, ModelMeta>> = {
${metaLines}
};
`;
}
