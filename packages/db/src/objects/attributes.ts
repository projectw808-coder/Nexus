/**
 * Attribute definitions and field-level permissions (§5.2). `AttributePermission` rows override
 * the default (everything readable, writable per role) per attribute and role. The same
 * `attributeAccess` decision is used by the CASL ability, the record serializer and the export
 * job — one function, three call sites.
 */
import type { AttributeDef } from '@nexus/core';
import type { AttributeAccess, Role } from '../generated/prisma/enums.ts';
import type { Actor, TenantDb } from '../scoped.ts';

export type AttributeRow = {
  id: string;
  objectTypeId: string;
  apiSlug: string;
  title: string;
  description: string | null;
  type: AttributeDef['type'];
  config: unknown;
  isUnique: boolean;
  isRequired: boolean;
  isSystem: boolean;
  isIndexed: boolean;
  indexState: string;
  indexProgress: number;
  position: number;
  deletedAt: Date | null;
  permissions: { role: Role; access: AttributeAccess }[];
};

export function toDef(a: AttributeRow): AttributeDef {
  return {
    id: a.id,
    apiSlug: a.apiSlug,
    title: a.title,
    type: a.type,
    config: (a.config ?? {}) as Record<string, unknown>,
    isRequired: a.isRequired,
    isUnique: a.isUnique,
    isSystem: a.isSystem,
  };
}

/** Live attributes of an object type, in display order, with their permission rows. */
export async function loadAttributes(db: TenantDb, objectTypeId: string): Promise<AttributeRow[]> {
  const rows = await db.attribute.findMany({
    where: { objectTypeId, deletedAt: null },
    include: { permissions: { where: { deletedAt: null }, select: { role: true, access: true } } },
    orderBy: { position: 'asc' },
  });
  return rows.map((r) => ({ ...r, type: r.type, permissions: r.permissions }));
}

/** Effective access for an actor on one attribute: HIDDEN < READ < WRITE. */
export function attributeAccess(
  actor: Pick<Actor, 'role'>,
  attr: Pick<AttributeRow, 'permissions'>,
): AttributeAccess {
  const row = attr.permissions.find((p) => p.role === actor.role);
  if (row) return row.access;
  return actor.role === 'VIEWER' ? 'READ' : 'WRITE';
}

export function visibleAttributes(
  actor: Pick<Actor, 'role'>,
  attrs: AttributeRow[],
): AttributeRow[] {
  return attrs.filter((a) => attributeAccess(actor, a) !== 'HIDDEN');
}

export function writableAttributes(
  actor: Pick<Actor, 'role'>,
  attrs: AttributeRow[],
): AttributeRow[] {
  return attrs.filter((a) => attributeAccess(actor, a) === 'WRITE');
}

/** Strip values of attributes the actor may not see. Keeps `_unmapped` for owners/admins only. */
export function redactValues(
  actor: Pick<Actor, 'role'>,
  attrs: AttributeRow[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(visibleAttributes(actor, attrs).map((a) => a.id));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === '_unmapped') {
      if (actor.role === 'OWNER' || actor.role === 'ADMIN') out[k] = v;
      continue;
    }
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}
