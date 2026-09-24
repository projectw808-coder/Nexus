import { NexusError } from '@nexus/core';
import {
  loadAttributes,
  redactValues,
  visibleAttributes,
  type Actor,
  type AttributeRow,
  type RecordRow,
  type TenantDb,
} from '@nexus/db';

export type ObjectTypeRow = {
  id: string;
  apiSlug: string;
  singular: string;
  plural: string;
  isSystem: boolean;
  icon: string | null;
  description: string | null;
};

/** Resolve an object type by apiSlug or id within the current tenant. */
export async function resolveObjectType(db: TenantDb, ref: string): Promise<ObjectTypeRow> {
  const row = await db.objectType.findFirst({
    where: { deletedAt: null, OR: [{ apiSlug: ref }, ...(isUuid(ref) ? [{ id: ref }] : [])] },
    select: {
      id: true,
      apiSlug: true,
      singular: true,
      plural: true,
      isSystem: true,
      icon: true,
      description: true,
    },
  });
  if (!row)
    throw new NexusError('NOT_FOUND', { context: { reason: `No object called "${ref}".` } });
  return row;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function attributesFor(db: TenantDb, objectTypeId: string): Promise<AttributeRow[]> {
  return loadAttributes(db, objectTypeId);
}

export type PublicAttribute = {
  id: string;
  apiSlug: string;
  title: string;
  description: string | null;
  type: AttributeRow['type'];
  config: Record<string, unknown>;
  isRequired: boolean;
  isUnique: boolean;
  isSystem: boolean;
  isIndexed: boolean;
  indexState: string;
  indexProgress: number;
  position: number;
  access: 'READ' | 'WRITE';
  /** Per-role overrides; only populated for owners/admins (who manage the schema). */
  permissions: { role: string; access: string }[];
};

export function publicAttributes(actor: Actor, attrs: AttributeRow[]): PublicAttribute[] {
  return visibleAttributes(actor, attrs).map((a) => ({
    id: a.id,
    apiSlug: a.apiSlug,
    title: a.title,
    description: a.description,
    type: a.type,
    config: (a.config ?? {}) as Record<string, unknown>,
    isRequired: a.isRequired,
    isUnique: a.isUnique,
    isSystem: a.isSystem,
    isIndexed: a.isIndexed,
    indexState: a.indexState,
    indexProgress: a.indexProgress,
    position: a.position,
    permissions:
      actor.role === 'OWNER' || actor.role === 'ADMIN'
        ? a.permissions.map((p) => ({ role: p.role, access: p.access }))
        : [],
    access:
      a.permissions.find((p) => p.role === actor.role)?.access === 'READ' || actor.role === 'VIEWER'
        ? 'READ'
        : 'WRITE',
  }));
}

export type PublicRecord = {
  id: string;
  objectTypeId: string;
  values: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export function publicRecord(actor: Actor, attrs: AttributeRow[], r: RecordRow): PublicRecord {
  return {
    id: r.id,
    objectTypeId: r.objectTypeId,
    values: redactValues(actor, attrs, r.values),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/** Human-readable label for a record: first TEXT/EMAIL value in attribute order, else the id. */
export function recordLabel(attrs: AttributeRow[], values: Record<string, unknown>): string {
  const name =
    attrs.find((a) => a.apiSlug === 'name') ??
    attrs.find((a) => a.type === 'TEXT') ??
    attrs.find((a) => a.type === 'EMAIL');
  const v = name ? values[name.id] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : '(untitled)';
}
