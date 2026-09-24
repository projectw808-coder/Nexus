/**
 * The records table keeps its whole state in the URL so every view is a link (§0.8: shareable,
 * back-button safe). This module maps `searchParams` ⇄ the tRPC `recordQuerySchema` input.
 *
 *   q=<search>  sort=<attributeSlug|createdAt|updatedAt>  dir=asc|desc  cursor=<opaque>
 *   f=<attributeSlug>:<op>:<value>   (repeatable; value is `,`-separated for list operators)
 *
 * Values are coerced to the attribute's type here because the DSL is typed (a NUMBER filter
 * needs a number). Pure and client-safe.
 */
import { FILTER_OPS, filterOpsFor, type Filter, type FilterOp, type Sort } from '@nexus/core';
import type { AttributeLike } from '@/lib/attributes';

export type SearchParams = Record<string, string | string[] | undefined>;

export type UrlFilter = { attribute: string; op: FilterOp; value: string };

export type TableQuery = {
  q?: string;
  sort?: string;
  dir: 'asc' | 'desc';
  cursor?: string;
  filters: UrlFilter[];
};

export const SYSTEM_COLUMNS = ['createdAt', 'updatedAt'] as const;

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  startsWith: 'starts with',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  in: 'is any of',
  notIn: 'is none of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  hasAny: 'has any of',
  hasAll: 'has all of',
};

export function opNeedsValue(op: FilterOp): boolean {
  return op !== 'isEmpty' && op !== 'isNotEmpty';
}

export function opTakesList(op: FilterOp): boolean {
  return op === 'in' || op === 'notIn' || op === 'hasAny' || op === 'hasAll';
}

function isFilterOp(s: string): s is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(s);
}

function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
}

export function parseFilterParam(raw: string): UrlFilter | null {
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const attribute = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  const j = rest.indexOf(':');
  const op = j === -1 ? rest : rest.slice(0, j);
  const value = j === -1 ? '' : rest.slice(j + 1);
  if (!isFilterOp(op)) return null;
  return { attribute, op, value };
}

export function parseTableQuery(sp: SearchParams): TableQuery {
  const dir = first(sp['dir']) === 'desc' ? 'desc' : 'asc';
  const q = first(sp['q']);
  const sort = first(sp['sort']);
  const cursor = first(sp['cursor']);
  return {
    ...(q ? { q } : {}),
    ...(sort ? { sort } : {}),
    dir,
    ...(cursor ? { cursor } : {}),
    filters: all(sp['f'])
      .map(parseFilterParam)
      .filter((f): f is UrlFilter => f !== null),
  };
}

export function filterParam(f: UrlFilter): string {
  return opNeedsValue(f.op) ? `${f.attribute}:${f.op}:${f.value}` : `${f.attribute}:${f.op}`;
}

export function tableQueryParams(q: TableQuery, extra?: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.sort) {
    p.set('sort', q.sort);
    p.set('dir', q.dir);
  }
  for (const f of q.filters) p.append('f', filterParam(f));
  if (q.cursor) p.set('cursor', q.cursor);
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

export function tableHref(base: string, q: TableQuery, extra?: Record<string, string>): string {
  const s = tableQueryParams(q, extra).toString();
  return s ? `${base}?${s}` : base;
}

/** A new query without the cursor (any change to filters/sort restarts pagination). */
export function withoutCursor(q: TableQuery): TableQuery {
  const { cursor: _cursor, ...rest } = q;
  return rest;
}

function coerceScalar(attr: AttributeLike | undefined, raw: string): unknown {
  if (!attr) return raw; // system columns (timestamps) stay strings
  switch (attr.type) {
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING':
    case 'FORMULA':
    case 'ROLLUP': {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'BOOLEAN':
      return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
    default:
      return raw;
  }
}

/**
 * Build the typed tRPC query. Filters on unknown attributes or with an operator the type does
 * not allow are dropped rather than sent — the API would reject the whole request otherwise.
 */
export function toRecordQuery(
  q: TableQuery,
  attrs: readonly AttributeLike[],
  limit: number,
): { filters: Filter[]; sort: Sort[]; search?: string; cursor?: string; limit: number } {
  const find = (key: string) => attrs.find((a) => a.apiSlug === key || a.id === key);
  const filters: Filter[] = [];
  for (const f of q.filters) {
    const isSystem = (SYSTEM_COLUMNS as readonly string[]).includes(f.attribute);
    const attr = find(f.attribute);
    if (!attr && !isSystem) continue;
    if (attr && !filterOpsFor(attr.type).includes(f.op)) continue;
    if (!opNeedsValue(f.op)) {
      filters.push({ attribute: f.attribute, op: f.op });
      continue;
    }
    if (opTakesList(f.op)) {
      const list = f.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => coerceScalar(attr, s));
      if (list.length === 0) continue;
      filters.push({ attribute: f.attribute, op: f.op, value: list });
      continue;
    }
    filters.push({ attribute: f.attribute, op: f.op, value: coerceScalar(attr, f.value) });
  }
  const sort: Sort[] = [];
  if (q.sort) {
    const isSystem = (SYSTEM_COLUMNS as readonly string[]).includes(q.sort);
    if (isSystem || find(q.sort)) sort.push({ attribute: q.sort, direction: q.dir });
  }
  return {
    filters,
    sort,
    ...(q.q ? { search: q.q } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    limit,
  };
}

/** Saved views store the typed DSL; turn it back into URL state (ids become slugs when known). */
export function tableQueryFromView(
  viewFilters: unknown,
  viewSorts: unknown,
  attrs: readonly AttributeLike[],
): TableQuery {
  const slugOf = (key: string) => attrs.find((a) => a.id === key)?.apiSlug ?? key;
  const filters: UrlFilter[] = [];
  if (Array.isArray(viewFilters)) {
    for (const raw of viewFilters) {
      if (!raw || typeof raw !== 'object') continue;
      const { attribute, op, value } = raw as {
        attribute?: unknown;
        op?: unknown;
        value?: unknown;
      };
      if (typeof attribute !== 'string' || typeof op !== 'string' || !isFilterOp(op)) continue;
      const v = Array.isArray(value)
        ? value.map((x) => scalarText(x)).join(',')
        : value == null
          ? ''
          : scalarText(value);
      filters.push({ attribute: slugOf(attribute), op, value: v });
    }
  }
  let sort: string | undefined;
  let dir: 'asc' | 'desc' = 'asc';
  if (Array.isArray(viewSorts) && viewSorts[0] && typeof viewSorts[0] === 'object') {
    const s = viewSorts[0] as { attribute?: unknown; direction?: unknown };
    if (typeof s.attribute === 'string') {
      sort = slugOf(s.attribute);
      dir = s.direction === 'desc' ? 'desc' : 'asc';
    }
  }
  return { ...(sort ? { sort } : {}), dir, filters };
}

function scalarText(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint') return String(x);
  return JSON.stringify(x);
}
