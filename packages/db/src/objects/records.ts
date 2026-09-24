/**
 * Records: validated writes and the query builder (§6.2). Values are keyed by attribute id.
 * Filters and sorts on an attribute whose index is READY hit its generated column; otherwise
 * they use the immutable extraction functions over JSONB. Raw SQL is allowed here (packages/db)
 * and every statement carries the workspace id explicitly — RLS is also in force.
 */
import {
  NexusError,
  filterOpsFor,
  indexColumnKind,
  validateRecordValues,
  type Filter,
  type RecordQuery,
  type Sort,
} from '@nexus/core';
import { Prisma } from '../generated/prisma/client.ts';
import type { Actor, TenantDb } from '../scoped.ts';
import { toDef, writableAttributes, type AttributeRow } from './attributes.ts';

export type RecordRow = {
  id: string;
  objectTypeId: string;
  values: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  importJobId: string | null;
};

const HEX32 = /^[0-9a-f]{32}$/;

function stringifyScalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** Generated-column name for an attribute id (dashes stripped). */
export function genColumn(attributeId: string): string {
  const hex = attributeId.replace(/-/g, '').toLowerCase();
  if (!HEX32.test(hex)) throw new Error(`attribute id is not a uuid: ${attributeId}`);
  return `gen_${hex}`;
}

// ── expressions ───────────────────────────────────────────────────────────────

function valueExpr(attr: AttributeRow): Prisma.Sql {
  const kind = indexColumnKind(attr.type);
  if (attr.indexState === 'READY' && kind) {
    return Prisma.sql`r.${Prisma.raw(`"${genColumn(attr.id)}"`)}`;
  }
  const text = Prisma.sql`(r."values" ->> ${attr.id})`;
  switch (kind) {
    case 'numeric':
      return Prisma.sql`nexus_immutable_numeric(${text})`;
    case 'timestamptz':
      return Prisma.sql`nexus_immutable_timestamptz(${text})`;
    case 'boolean':
      return Prisma.sql`nexus_immutable_boolean(${text})`;
    default:
      return text;
  }
}

const SYSTEM_SORTS: Record<string, Prisma.Sql> = {
  createdAt: Prisma.sql`r."createdAt"`,
  updatedAt: Prisma.sql`r."updatedAt"`,
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function castList(kind: ReturnType<typeof indexColumnKind>, values: unknown[]): Prisma.Sql {
  const arr = values.map((v) => (v === null || v === undefined ? null : stringifyScalar(v)));
  switch (kind) {
    case 'numeric':
      return Prisma.sql`${arr}::text[]::numeric[]`;
    case 'timestamptz':
      return Prisma.sql`${arr}::text[]::timestamptz[]`;
    case 'boolean':
      return Prisma.sql`${arr}::text[]::boolean[]`;
    default:
      return Prisma.sql`${arr}::text[]`;
  }
}

function scalarParam(kind: ReturnType<typeof indexColumnKind>, value: unknown): Prisma.Sql {
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  switch (kind) {
    case 'numeric':
      return Prisma.sql`${s}::numeric`;
    case 'timestamptz':
      return Prisma.sql`${s}::timestamptz`;
    case 'boolean':
      return Prisma.sql`${s}::boolean`;
    default:
      return Prisma.sql`${s}`;
  }
}

function filterSql(attr: AttributeRow, f: Filter): Prisma.Sql {
  if (!filterOpsFor(attr.type).includes(f.op)) {
    throw new NexusError('VALIDATION', {
      context: { reason: `Operator ${f.op} is not valid for ${attr.apiSlug} (${attr.type}).` },
    });
  }
  const kind = indexColumnKind(attr.type);
  const json = Prisma.sql`(r."values" -> ${attr.id})`;
  const isSet = attr.type === 'MULTISELECT' || attr.type === 'RELATIONSHIP' || attr.type === 'USER';
  const isObject = attr.type === 'LOCATION' || attr.type === 'AI_RESEARCH';
  switch (f.op) {
    case 'isEmpty':
      if (isSet)
        return Prisma.sql`(jsonb_typeof(${json}) IS DISTINCT FROM 'array' OR jsonb_array_length(${json}) = 0)`;
      if (isObject) return Prisma.sql`(${json} IS NULL OR ${json} = 'null'::jsonb)`;
      return Prisma.sql`${valueExpr(attr)} IS NULL`;
    case 'isNotEmpty':
      if (isSet)
        return Prisma.sql`(jsonb_typeof(${json}) = 'array' AND jsonb_array_length(${json}) > 0)`;
      if (isObject) return Prisma.sql`(${json} IS NOT NULL AND ${json} <> 'null'::jsonb)`;
      return Prisma.sql`${valueExpr(attr)} IS NOT NULL`;
    case 'hasAny':
    case 'hasAll': {
      const list = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)];
      return f.op === 'hasAny'
        ? Prisma.sql`${json} ?| ${list}::text[]`
        : Prisma.sql`${json} ?& ${list}::text[]`;
    }
    case 'contains':
      return Prisma.sql`${valueExpr(attr)} ILIKE ${'%' + escapeLike(String(f.value)) + '%'}`;
    case 'startsWith':
      return Prisma.sql`${valueExpr(attr)} ILIKE ${escapeLike(String(f.value)) + '%'}`;
    case 'in':
    case 'notIn': {
      const list = Array.isArray(f.value) ? f.value : [f.value];
      const inner = Prisma.sql`${valueExpr(attr)} = ANY(${castList(kind, list)})`;
      return f.op === 'in' ? inner : Prisma.sql`NOT COALESCE(${inner}, false)`;
    }
    case 'eq':
      return Prisma.sql`${valueExpr(attr)} = ${scalarParam(kind, f.value)}`;
    case 'neq':
      return Prisma.sql`${valueExpr(attr)} IS DISTINCT FROM ${scalarParam(kind, f.value)}`;
    case 'gt':
      return Prisma.sql`${valueExpr(attr)} > ${scalarParam(kind, f.value)}`;
    case 'gte':
      return Prisma.sql`${valueExpr(attr)} >= ${scalarParam(kind, f.value)}`;
    case 'lt':
      return Prisma.sql`${valueExpr(attr)} < ${scalarParam(kind, f.value)}`;
    case 'lte':
      return Prisma.sql`${valueExpr(attr)} <= ${scalarParam(kind, f.value)}`;
  }
}

function systemFilterSql(column: string, f: Filter): Prisma.Sql {
  const col = SYSTEM_SORTS[column]!;
  const v = Prisma.sql`${String(f.value)}::timestamptz`;
  switch (f.op) {
    case 'gt':
      return Prisma.sql`${col} > ${v}`;
    case 'gte':
      return Prisma.sql`${col} >= ${v}`;
    case 'lt':
      return Prisma.sql`${col} < ${v}`;
    case 'lte':
      return Prisma.sql`${col} <= ${v}`;
    case 'eq':
      return Prisma.sql`${col} = ${v}`;
    default:
      throw new NexusError('VALIDATION', {
        context: { reason: `Operator ${f.op} is not valid for ${column}.` },
      });
  }
}

// ── query ─────────────────────────────────────────────────────────────────────

type SortPlan = { expr: Prisma.Sql; direction: 'asc' | 'desc'; nullsSentinel: Prisma.Sql | null };

function resolveAttr(attrs: AttributeRow[], key: string): AttributeRow | undefined {
  return attrs.find((a) => a.id === key || a.apiSlug === key);
}

function sortPlan(attrs: AttributeRow[], sorts: Sort[]): SortPlan[] {
  const plans: SortPlan[] = [];
  for (const s of sorts) {
    if (s.attribute in SYSTEM_SORTS) {
      plans.push({ expr: SYSTEM_SORTS[s.attribute]!, direction: s.direction, nullsSentinel: null });
      continue;
    }
    const attr = resolveAttr(attrs, s.attribute);
    if (!attr)
      throw new NexusError('VALIDATION', {
        context: { reason: `Unknown attribute ${s.attribute} in sort.` },
      });
    const kind = indexColumnKind(attr.type);
    if (!kind)
      throw new NexusError('VALIDATION', {
        context: { reason: `${attr.apiSlug} (${attr.type}) cannot be sorted on.` },
      });
    // Keyset pagination needs a total order: coalesce NULLs to a sentinel that sorts last.
    const sentinel =
      kind === 'numeric'
        ? Prisma.sql`${s.direction === 'asc' ? 'Infinity' : '-Infinity'}::numeric`
        : kind === 'timestamptz'
          ? Prisma.sql`${s.direction === 'asc' ? 'infinity' : '-infinity'}::timestamptz`
          : kind === 'boolean'
            ? Prisma.sql`${s.direction === 'asc'}::boolean`
            : Prisma.sql`${s.direction === 'asc' ? '￿' : ''}`;
    plans.push({ expr: valueExpr(attr), direction: s.direction, nullsSentinel: sentinel });
  }
  if (plans.length === 0)
    plans.push({ expr: SYSTEM_SORTS['updatedAt']!, direction: 'desc', nullsSentinel: null });
  return plans;
}

function coalesced(p: SortPlan): Prisma.Sql {
  return p.nullsSentinel ? Prisma.sql`COALESCE(${p.expr}, ${p.nullsSentinel})` : p.expr;
}

type Cursor = { k: unknown[]; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (!Array.isArray(c.k) || typeof c.id !== 'string') throw new Error('shape');
    return c;
  } catch {
    throw new NexusError('VALIDATION', { context: { reason: 'Invalid cursor.' } });
  }
}

export type QueryResult = { items: RecordRow[]; nextCursor: string | null };

/**
 * Cursor-paginated, filtered, sorted, searched records of one object type. The keyset is
 * (sort expressions…, id). Every filter/sort is validated against the attribute types.
 */
export async function queryRecords(
  db: TenantDb,
  params: {
    workspaceId: string;
    objectTypeId: string;
    attributes: AttributeRow[];
    query: RecordQuery;
  },
): Promise<QueryResult> {
  const { workspaceId, objectTypeId, attributes, query } = params;
  const where: Prisma.Sql[] = [
    Prisma.sql`r."workspaceId" = ${workspaceId}`,
    Prisma.sql`r."objectTypeId" = ${objectTypeId}`,
    Prisma.sql`r."mergeState" = 'ACTIVE'`,
  ];
  if (!query.includeDeleted) where.push(Prisma.sql`r."deletedAt" IS NULL`);

  for (const f of query.filters) {
    if (f.attribute in SYSTEM_SORTS) {
      where.push(systemFilterSql(f.attribute, f));
      continue;
    }
    const attr = resolveAttr(attributes, f.attribute);
    if (!attr)
      throw new NexusError('VALIDATION', {
        context: { reason: `Unknown attribute ${f.attribute} in filter.` },
      });
    where.push(filterSql(attr, f));
  }
  if (query.search) {
    const q = query.search;
    where.push(
      Prisma.sql`(r."searchVector" @@ websearch_to_tsquery('simple', ${q}) OR nexus_jsonb_text(r."values") ILIKE ${'%' + escapeLike(q) + '%'})`,
    );
  }

  const plans = sortPlan(attributes, query.sort);
  const keyExprs = [...plans.map(coalesced), Prisma.sql`r."id"`];
  const dir = plans[0]!.direction; // one direction across the keyset keeps row comparison valid
  const orderBy = Prisma.join(
    keyExprs.map((e) => Prisma.sql`${e} ${Prisma.raw(dir === 'asc' ? 'ASC' : 'DESC')}`),
    ', ',
  );

  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    if (c.k.length !== plans.length)
      throw new NexusError('VALIDATION', {
        context: { reason: 'Cursor does not match the sort.' },
      });
    const rhs = [
      ...plans.map((p, i) => {
        const v = c.k[i];
        if (p.nullsSentinel === null) return Prisma.sql`${String(v)}::timestamptz`;
        const kindSql = p.nullsSentinel; // same type as the sentinel
        return Prisma.sql`(${String(v)})::${Prisma.raw(sqlTypeOfSentinel(kindSql))}`;
      }),
      Prisma.sql`${c.id}`,
    ];
    where.push(
      Prisma.sql`(${Prisma.join(keyExprs, ', ')}) ${Prisma.raw(dir === 'asc' ? '>' : '<')} (${Prisma.join(rhs, ', ')})`,
    );
  }

  const keySelect = Prisma.join(
    plans.map((p, i) => Prisma.sql`${coalesced(p)}::text AS ${Prisma.raw(`"k${i}"`)}`),
    ', ',
  );
  const rows = await db.$queryRaw<(RecordRow & Record<string, unknown>)[]>(Prisma.sql`
    SELECT r."id", r."objectTypeId", r."values", r."createdAt", r."updatedAt", r."deletedAt", r."importJobId", ${keySelect}
    FROM "Record" r
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${query.limit + 1}
  `);
  const page = rows.slice(0, query.limit);
  const last = rows.length > query.limit ? page[page.length - 1] : undefined;
  const items = page.map((r) => ({
    id: r.id,
    objectTypeId: r.objectTypeId,
    values: r.values ?? {},
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    importJobId: r.importJobId,
  }));
  return {
    items,
    nextCursor: last ? encodeCursor({ k: plans.map((_, i) => last[`k${i}`]), id: last.id }) : null,
  };
}

function sqlTypeOfSentinel(s: Prisma.Sql): string {
  const text = s.strings.join('?');
  if (text.includes('::numeric')) return 'numeric';
  if (text.includes('::timestamptz')) return 'timestamptz';
  if (text.includes('::boolean')) return 'boolean';
  return 'text';
}

export async function countRecords(
  db: TenantDb,
  params: {
    workspaceId: string;
    objectTypeId: string;
    attributes: AttributeRow[];
    filters: Filter[];
    search?: string;
  },
): Promise<number> {
  const { workspaceId, objectTypeId, attributes } = params;
  const where: Prisma.Sql[] = [
    Prisma.sql`r."workspaceId" = ${workspaceId}`,
    Prisma.sql`r."objectTypeId" = ${objectTypeId}`,
    Prisma.sql`r."mergeState" = 'ACTIVE'`,
    Prisma.sql`r."deletedAt" IS NULL`,
  ];
  for (const f of params.filters) {
    const attr = resolveAttr(attributes, f.attribute);
    if (!attr)
      throw new NexusError('VALIDATION', {
        context: { reason: `Unknown attribute ${f.attribute} in filter.` },
      });
    where.push(filterSql(attr, f));
  }
  if (params.search) {
    where.push(
      Prisma.sql`(r."searchVector" @@ websearch_to_tsquery('simple', ${params.search}) OR nexus_jsonb_text(r."values") ILIKE ${'%' + escapeLike(params.search) + '%'})`,
    );
  }
  const rows = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::int AS n FROM "Record" r WHERE ${Prisma.join(where, ' AND ')}`,
  );
  return rows[0]?.n ?? 0;
}

// ── writes ────────────────────────────────────────────────────────────────────

async function assertUnique(
  db: TenantDb,
  workspaceId: string,
  objectTypeId: string,
  attrs: AttributeRow[],
  values: Record<string, unknown>,
  exceptId: string | null,
): Promise<void> {
  for (const a of attrs) {
    if (!a.isUnique || !(a.id in values) || values[a.id] === null) continue;
    const v = values[a.id];
    const clash = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r."id" FROM "Record" r
      WHERE r."workspaceId" = ${workspaceId} AND r."objectTypeId" = ${objectTypeId} AND r."deletedAt" IS NULL
        AND r."mergeState" = 'ACTIVE' AND (r."values" ->> ${a.id}) = ${typeof v === 'string' ? v : JSON.stringify(v)}
        ${exceptId ? Prisma.sql`AND r."id" <> ${exceptId}` : Prisma.empty}
      LIMIT 1`);
    if (clash.length > 0) {
      throw new NexusError('CONFLICT', {
        context: { reason: `A ${a.title.toLowerCase()} of "${String(v)}" already exists.` },
        details: { attributeId: a.id, existingId: clash[0]!.id },
      });
    }
  }
}

/** Keep RecordRelation rows in step with RELATIONSHIP values (both directions of the graph). */
async function syncRelations(
  db: TenantDb,
  workspaceId: string,
  recordId: string,
  attrs: AttributeRow[],
  values: Record<string, unknown>,
): Promise<void> {
  for (const a of attrs) {
    if (a.type !== 'RELATIONSHIP' || !(a.id in values)) continue;
    const targets = Array.isArray(values[a.id]) ? (values[a.id] as string[]) : [];
    await db.recordRelation.deleteMany({ where: { fromRecordId: recordId, attributeId: a.id } });
    if (targets.length === 0) continue;
    const targetType = (a.config as Record<string, unknown>)['targetObjectTypeId'];
    const found = await db.record.findMany({
      where: {
        id: { in: targets },
        deletedAt: null,
        ...(typeof targetType === 'string' ? { objectTypeId: targetType } : {}),
      },
      select: { id: true },
    });
    if (found.length !== targets.length) {
      throw new NexusError('VALIDATION', {
        context: { reason: `${a.title}: a linked record does not exist.` },
        details: { attributeId: a.id },
      });
    }
    await db.recordRelation.createMany({
      data: targets.map((toRecordId) => ({
        workspaceId,
        fromRecordId: recordId,
        toRecordId,
        attributeId: a.id,
      })),
    });
  }
}

function assertWritable(
  actor: Actor,
  attrs: AttributeRow[],
  values: Record<string, unknown>,
): void {
  const writable = new Set(writableAttributes(actor, attrs).map((a) => a.id));
  const denied = Object.keys(values).filter((k) => k !== '_unmapped' && !writable.has(k));
  if (denied.length > 0) {
    const names = denied.map((id) => attrs.find((a) => a.id === id)?.apiSlug ?? id);
    throw new NexusError('FORBIDDEN', {
      context: { reason: `You cannot edit ${names.join(', ')}.` },
      details: { attributeIds: denied },
    });
  }
}

export async function createRecord(
  db: TenantDb,
  actor: Actor,
  params: {
    objectTypeId: string;
    attributes: AttributeRow[];
    input: Record<string, unknown>;
    importJobId?: string | null;
  },
): Promise<RecordRow> {
  const defs = params.attributes.map(toDef);
  const validated = validateRecordValues(defs, params.input, 'create');
  if (!validated.ok) throw validated.error;
  assertWritable(actor, params.attributes, validated.value.values);
  await assertUnique(
    db,
    actor.workspaceId,
    params.objectTypeId,
    params.attributes,
    validated.value.values,
    null,
  );
  const row = await db.record.create({
    data: {
      workspaceId: actor.workspaceId,
      objectTypeId: params.objectTypeId,
      values: validated.value.values as Prisma.InputJsonValue,
      createdById: actor.userId,
      importJobId: params.importJobId ?? null,
    },
  });
  await syncRelations(db, actor.workspaceId, row.id, params.attributes, validated.value.values);
  return { ...row, values: row.values as Record<string, unknown> };
}

export async function updateRecord(
  db: TenantDb,
  actor: Actor,
  params: { recordId: string; attributes: AttributeRow[]; input: Record<string, unknown> },
): Promise<{ before: RecordRow; after: RecordRow }> {
  const existing = await db.record.findFirst({
    where: { id: params.recordId, deletedAt: null, mergeState: 'ACTIVE' },
  });
  if (!existing) throw new NexusError('NOT_FOUND');
  const defs = params.attributes.map(toDef);
  const validated = validateRecordValues(defs, params.input, 'update');
  if (!validated.ok) throw validated.error;
  assertWritable(actor, params.attributes, validated.value.values);
  const merged: Record<string, unknown> = { ...(existing.values as Record<string, unknown>) };
  for (const [k, v] of Object.entries(validated.value.values)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  await assertUnique(
    db,
    actor.workspaceId,
    existing.objectTypeId,
    params.attributes,
    validated.value.values,
    existing.id,
  );
  const row = await db.record.update({
    where: { id: existing.id },
    data: { values: merged as Prisma.InputJsonValue },
  });
  await syncRelations(db, actor.workspaceId, row.id, params.attributes, validated.value.values);
  return {
    before: { ...existing, values: existing.values as Record<string, unknown> },
    after: { ...row, values: row.values as Record<string, unknown> },
  };
}

export async function softDeleteRecords(db: TenantDb, ids: string[]): Promise<number> {
  const r = await db.record.updateMany({
    where: { id: { in: ids }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  await db.listEntry.updateMany({
    where: { recordId: { in: ids }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return r.count;
}

export async function restoreRecords(db: TenantDb, ids: string[]): Promise<number> {
  const r = await db.record.updateMany({
    where: { id: { in: ids }, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  await db.listEntry.updateMany({
    where: { recordId: { in: ids }, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  return r.count;
}
