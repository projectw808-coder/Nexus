/**
 * Field mapping (Phase 9 build spec, "Integrations hub & health console"): lets a workspace
 * pick which platform field lands on which Nexus attribute, per connection, instead of always
 * taking a connector's built-in defaults. `FieldMapping`/`FieldMappingRule` have existed in the
 * schema since an earlier phase with zero runtime consumers — this file is their first backend.
 *
 * Not wired into the live sync pipeline: `packages/sync/src/stages/normalize.ts` does not branch
 * on `Connection.fieldMappingId` yet, so `previewFieldMapping` below is a deliberately smaller
 * feature (raw-payload path extraction) than a full simulated normalize + mapping-resolution
 * pass — see its doc comment.
 */
import { NexusError } from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Platform } from '../generated/prisma/enums.ts';
import type { Actor, TenantDb } from '../scoped.ts';

export type FieldMappingRuleRow = {
  id: string;
  fieldMappingId: string;
  sourceKind: string;
  sourcePath: string;
  attributeId: string;
  transform: unknown;
  position: number;
};

export type FieldMappingRow = {
  id: string;
  workspaceId: string;
  platform: Platform;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  rules: FieldMappingRuleRow[];
};

const RULE_SELECT = {
  id: true,
  fieldMappingId: true,
  sourceKind: true,
  sourcePath: true,
  attributeId: true,
  transform: true,
  position: true,
} satisfies Prisma.FieldMappingRuleSelect;

const MAPPING_SELECT = {
  id: true,
  workspaceId: true,
  platform: true,
  name: true,
  description: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  rules: {
    where: { deletedAt: null },
    orderBy: { position: 'asc' },
    select: RULE_SELECT,
  },
} satisfies Prisma.FieldMappingSelect;

/** All (non-deleted) field mappings, optionally narrowed to one platform, rules ordered by position. */
export async function listFieldMappings(
  db: TenantDb,
  platform?: Platform,
): Promise<FieldMappingRow[]> {
  return db.fieldMapping.findMany({
    where: { deletedAt: null, ...(platform ? { platform } : {}) },
    orderBy: { name: 'asc' },
    select: MAPPING_SELECT,
  });
}

export async function getFieldMapping(db: TenantDb, id: string): Promise<FieldMappingRow | null> {
  return db.fieldMapping.findFirst({ where: { id, deletedAt: null }, select: MAPPING_SELECT });
}

export async function createFieldMapping(
  db: TenantDb,
  actor: Actor,
  input: { platform: Platform; name: string; description?: string | null },
): Promise<{ id: string }> {
  const row = await db.fieldMapping.create({
    data: {
      workspaceId: actor.workspaceId,
      platform: input.platform,
      name: input.name,
      description: input.description ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

export async function updateFieldMapping(
  db: TenantDb,
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  await db.fieldMapping.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    },
  });
}

/**
 * Soft-deletes the mapping only. Its rules are left in place rather than also soft-deleted:
 * they are only ever read through a mapping that is itself filtered on `deletedAt: null`
 * (see `MAPPING_SELECT`/`listFieldMappings`), so an orphaned rule is simply unreachable — and
 * leaving it avoids a second write (and a second thing that could half-fail) for no visible gain.
 */
export async function deleteFieldMapping(db: TenantDb, id: string): Promise<void> {
  await db.fieldMapping.update({ where: { id }, data: { deletedAt: new Date() } });
}

/**
 * Replace-all: delete every existing rule for this mapping and insert the given set. Simpler and
 * safer than fine-grained per-rule CRUD for a drag-and-drop UI that reorders/edits the whole list
 * at once. Validates every `attributeId` exists in this workspace before writing anything.
 */
export async function setFieldMappingRules(
  db: TenantDb,
  actor: Actor,
  fieldMappingId: string,
  rules: {
    sourceKind: string;
    sourcePath: string;
    attributeId: string;
    transform?: unknown;
    position: number;
  }[],
): Promise<void> {
  const attributeIds = [...new Set(rules.map((r) => r.attributeId))];
  if (attributeIds.length > 0) {
    const found = await db.attribute.findMany({
      where: { id: { in: attributeIds }, deletedAt: null },
      select: { id: true },
    });
    const foundIds = new Set(found.map((a) => a.id));
    const missing = attributeIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NexusError('VALIDATION', {
        context: { reason: `Unknown attribute id(s): ${missing.join(', ')}` },
        details: { attributeIds: missing },
      });
    }
  }

  await db.fieldMappingRule.deleteMany({ where: { fieldMappingId } });
  if (rules.length === 0) return;
  await db.fieldMappingRule.createMany({
    data: rules.map((r) => ({
      workspaceId: actor.workspaceId,
      fieldMappingId,
      sourceKind: r.sourceKind,
      sourcePath: r.sourcePath,
      attributeId: r.attributeId,
      transform: (r.transform ?? null) as Prisma.InputJsonValue,
      position: r.position,
    })),
  });
}

/** Assign (or, with `null`, unassign) the field mapping a connection uses instead of connector defaults. */
export async function assignFieldMapping(
  db: TenantDb,
  connectionId: string,
  fieldMappingId: string | null,
): Promise<void> {
  await db.connection.update({ where: { id: connectionId }, data: { fieldMappingId } });
}

/**
 * Dot-path read into an arbitrary value: `getByPath({a: {b: [1, {c: 2}]}}, 'a.b.1.c') === 2`.
 * Plain object-key and array-index segments only (no wildcards, no bracket syntax). Returns
 * `undefined` the moment a segment is missing or the current value isn't indexable, and for an
 * empty path.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (path === '') return undefined;
  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Live preview for the field-mapping tab: the 3 most recent raw `ExternalObject` payloads for a
 * connection + connector `kind` (e.g. `"ig_comment"` — NOT a canonical kind), each with every
 * rule applied to it.
 *
 * Simplification (deliberate, out of scope this phase): `ExternalObject.kind` is a
 * connector-specific string, while `rule.sourceKind` names a *canonical* entity kind
 * (`'person'`, `'message'`, …), and one raw object can normalize into several canonical
 * entities. Rather than actually running a connector's `normalize()` and resolving which
 * entity each rule's `sourceKind` applies to, this preview applies EVERY rule to EVERY sample's
 * raw payload via `getByPath(raw, rule.sourcePath)`, ignoring `sourceKind` entirely. It answers
 * "what would this path pull out of the raw JSON", which is what someone wiring up a mapping by
 * hand actually wants to see — not a full simulated mapping-resolution pass (no code path
 * branches on `Connection.fieldMappingId` yet, so nothing here contradicts current behavior).
 */
export async function previewFieldMapping(
  db: TenantDb,
  input: {
    connectionId: string;
    kind: string;
    rules: { sourceKind: string; sourcePath: string; attributeId: string }[];
  },
): Promise<{ raw: unknown; mapped: Record<string, unknown> }[]> {
  const samples = await db.externalObject.findMany({
    where: { connectionId: input.connectionId, kind: input.kind, deletedAt: null },
    orderBy: { fetchedAt: 'desc' },
    take: 3,
    select: { raw: true },
  });
  return samples.map((s) => {
    const mapped: Record<string, unknown> = {};
    for (const rule of input.rules) {
      mapped[rule.attributeId] = getByPath(s.raw, rule.sourcePath);
    }
    return { raw: s.raw, mapped };
  });
}
