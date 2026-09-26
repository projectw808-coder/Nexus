/**
 * The condition tree (spec §14 "Conditions"): a JSON-logic-lite expression over an arbitrary
 * evaluation context. Pure — no I/O, no db, no clock — so the visual builder, the raw-JSON
 * escape hatch, the live engine and the dry run all agree on what a condition means.
 *
 * Evaluation never throws: a path that does not exist reads as `undefined`, and `undefined`
 * satisfies `isEmpty` and nothing else.
 */
import { z } from 'zod';

export const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionLeaf = { path: string; op: ConditionOp; value?: unknown };

export type ConditionNode =
  | { and: ConditionNode[] }
  | { or: ConditionNode[] }
  | { not: ConditionNode }
  | { leaf: ConditionLeaf };

export const conditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(conditionSchema) }),
    z.object({ or: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
    z.object({
      leaf: z.object({
        path: z.string().min(1),
        op: z.enum(CONDITION_OPS),
        // Op-specific value shapes are validated loosely on purpose: `in`/`notIn` want an array,
        // the comparisons want a number or an ISO date, and `isEmpty`/`isNotEmpty` want nothing.
        // A wrong shape evaluates to `false` rather than failing the whole workflow to parse.
        value: z.unknown().optional(),
      }),
    }),
  ]),
);

/**
 * Read a dot-path out of an arbitrary value. Walks objects (and arrays, by numeric index) and
 * returns `undefined` the moment a step is missing or lands on a non-object. Never throws.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cursor: unknown = obj;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** `null`, `undefined`, `''` and `[]` are empty. Everything else (including `0`, `false`) is not. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

/** A number, or a Date / ISO-8601 date string as epoch millis. `null` when it is neither. */
function asComparable(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    const [x, y] = [asComparable(a), asComparable(b)];
    return x !== null && y !== null && x === y;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function evaluateLeaf(leaf: ConditionLeaf, ctx: unknown): boolean {
  const actual = getByPath(ctx, leaf.path);

  // A missing path satisfies `isEmpty` and nothing else — never an exception, never a surprise
  // "true" from a negating operator over data that simply is not there.
  if (actual === undefined) return leaf.op === 'isEmpty';

  switch (leaf.op) {
    case 'isEmpty':
      return isEmptyValue(actual);
    case 'isNotEmpty':
      return !isEmptyValue(actual);
    case 'eq':
      return looseEq(actual, leaf.value);
    case 'neq':
      return !looseEq(actual, leaf.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = asComparable(actual);
      const right = asComparable(leaf.value);
      if (left === null || right === null) return false;
      if (leaf.op === 'gt') return left > right;
      if (leaf.op === 'gte') return left >= right;
      if (leaf.op === 'lt') return left < right;
      return left <= right;
    }
    case 'contains':
      return typeof actual === 'string' && typeof leaf.value === 'string'
        ? actual.toLowerCase().includes(leaf.value.toLowerCase())
        : false;
    case 'in':
      return (
        Array.isArray(leaf.value) && leaf.value.some((candidate) => looseEq(actual, candidate))
      );
    case 'notIn':
      return Array.isArray(leaf.value)
        ? !leaf.value.some((candidate) => looseEq(actual, candidate))
        : false;
    default:
      return false;
  }
}

/** Evaluate a condition tree against a context object. Pure; never throws. */
export function evaluateCondition(node: ConditionNode, ctx: Record<string, unknown>): boolean {
  if ('and' in node) return node.and.every((child) => evaluateCondition(child, ctx));
  if ('or' in node) return node.or.some((child) => evaluateCondition(child, ctx));
  if ('not' in node) return !evaluateCondition(node.not, ctx);
  return evaluateLeaf(node.leaf, ctx);
}

/**
 * Coerce a stored `Workflow.conditions` value into a tree. `null`, `{}` and `[]` (the column
 * default) all mean "no conditions" and come back as `null`, which callers treat as always-true.
 * A non-empty array is an implicit `and`.
 */
export function parseConditions(raw: unknown): ConditionNode | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    return { and: raw.map((entry) => conditionSchema.parse(entry)) };
  }
  if (typeof raw === 'object' && Object.keys(raw).length === 0) return null;
  return conditionSchema.parse(raw);
}

/** `parseConditions` + `evaluateCondition`, with "no conditions" meaning true. */
export function conditionsMatch(raw: unknown, ctx: Record<string, unknown>): boolean {
  const tree = parseConditions(raw);
  return tree === null ? true : evaluateCondition(tree, ctx);
}
