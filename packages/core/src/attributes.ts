/**
 * The attribute type system (§6.2). `Record.values` is JSONB keyed by ATTRIBUTE ID (not slug —
 * renames never touch records, ADR-009). Every write is validated here against the object's
 * attributes; every filter is type-checked against `FILTER_OPS`. Pure: no I/O.
 */
import { z } from 'zod';
import { NexusError } from './errors.ts';
import { type Result, err, ok } from './result.ts';

export const ATTRIBUTE_TYPES = [
  'TEXT',
  'NUMBER',
  'CURRENCY',
  'DATE',
  'DATETIME',
  'SELECT',
  'MULTISELECT',
  'BOOLEAN',
  'EMAIL',
  'PHONE',
  'URL',
  'RATING',
  'STATUS',
  'RELATIONSHIP',
  'USER',
  'LOCATION',
  'AI_RESEARCH',
  'FORMULA',
  'ROLLUP',
  'SOCIAL_HANDLE',
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** Computed types: never accepted on write; produced by jobs (Phase 10). */
export const COMPUTED_TYPES: ReadonlySet<AttributeType> = new Set([
  'FORMULA',
  'ROLLUP',
  'AI_RESEARCH',
]);

/** Types whose value can live in a generated btree column (§6.6 immutable-extraction whitelist). */
export const INDEXABLE_TYPES: ReadonlySet<AttributeType> = new Set([
  'TEXT',
  'EMAIL',
  'PHONE',
  'URL',
  'SOCIAL_HANDLE',
  'SELECT',
  'STATUS',
  'NUMBER',
  'CURRENCY',
  'RATING',
  'BOOLEAN',
  'DATE',
  'DATETIME',
]);

/** SQL column family for an indexable type. */
export function indexColumnKind(
  type: AttributeType,
): 'text' | 'numeric' | 'boolean' | 'timestamptz' | null {
  switch (type) {
    case 'TEXT':
    case 'EMAIL':
    case 'PHONE':
    case 'URL':
    case 'SOCIAL_HANDLE':
    case 'SELECT':
    case 'STATUS':
      return 'text';
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING':
      return 'numeric';
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
    case 'DATETIME':
      return 'timestamptz';
    default:
      return null;
  }
}

// ── config per type ───────────────────────────────────────────────────────────

export const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  color: z.string().max(32).optional(),
  /** STATUS only: open | won | lost | archived — drives pipeline semantics. */
  category: z.enum(['open', 'won', 'lost', 'archived']).optional(),
});
export type Option = z.infer<typeof optionSchema>;

const optionsConfig = z.object({ options: z.array(optionSchema).min(1).max(200) });

export const CONFIG_SCHEMAS: Record<AttributeType, z.ZodType> = {
  TEXT: z.object({
    multiline: z.boolean().optional(),
    maxLength: z.number().int().positive().max(100_000).optional(),
  }),
  NUMBER: z.object({
    precision: z.number().int().min(0).max(10).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  CURRENCY: z.object({
    currency: z.string().length(3).toUpperCase().default('USD'),
    precision: z.number().int().min(0).max(6).optional(),
  }),
  DATE: z.object({}),
  DATETIME: z.object({}),
  SELECT: optionsConfig,
  MULTISELECT: optionsConfig,
  BOOLEAN: z.object({}),
  EMAIL: z.object({}),
  PHONE: z.object({ defaultCountry: z.string().length(2).optional() }),
  URL: z.object({}),
  RATING: z.object({ max: z.number().int().min(1).max(10).default(5) }),
  STATUS: optionsConfig,
  RELATIONSHIP: z.object({
    targetObjectTypeId: z.string().uuid(),
    multiple: z.boolean().default(false),
  }),
  USER: z.object({ multiple: z.boolean().default(false) }),
  LOCATION: z.object({}),
  AI_RESEARCH: z.object({
    prompt: z.string().min(1).max(4000),
    outputType: z.enum(['TEXT', 'NUMBER', 'BOOLEAN', 'SELECT']).default('TEXT'),
    options: z.array(optionSchema).optional(),
    refreshDays: z.number().int().positive().optional(),
  }),
  FORMULA: z.object({
    expression: z.string().min(1).max(4000),
    outputType: z.enum(['TEXT', 'NUMBER', 'BOOLEAN', 'DATE']).default('NUMBER'),
  }),
  ROLLUP: z.object({
    relationAttributeId: z.string().uuid(),
    targetAttributeId: z.string().uuid().optional(),
    aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  }),
  SOCIAL_HANDLE: z.object({ platform: z.string().max(32).optional() }),
};

export function parseAttributeConfig(
  type: AttributeType,
  config: unknown,
): Result<Record<string, unknown>> {
  const schema = CONFIG_SCHEMAS[type];
  const r = schema.safeParse(config ?? {});
  if (!r.success) {
    return err(
      new NexusError('VALIDATION', {
        context: { reason: `Invalid configuration for a ${type} attribute.` },
        details: {
          issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      }),
    );
  }
  return ok(r.data as Record<string, unknown>);
}

// ── values ────────────────────────────────────────────────────────────────────

export type AttributeDef = {
  id: string;
  apiSlug: string;
  title: string;
  type: AttributeType;
  config: Record<string, unknown>;
  isRequired: boolean;
  isUnique: boolean;
  isSystem: boolean;
};

const E164 = /^\+[1-9]\d{6,14}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE = /^@?[A-Za-z0-9._-]{1,64}$/;

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 date-time');

export const locationSchema = z.object({
  address: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  country: z.string().length(2).optional(),
  postalCode: z.string().max(32).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const aiResearchValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  sources: z.array(z.object({ url: z.url(), title: z.string().optional() })).default([]),
  asOf: isoDateTime,
  confidence: z.number().min(0).max(1).optional(),
});

/** Zod schema for one attribute's stored value (not null/undefined — absence is handled outside). */
export function valueSchema(attr: AttributeDef): z.ZodType {
  const c = attr.config;
  const optionIds = (ids: unknown) =>
    new Set((Array.isArray(ids) ? (ids as Option[]) : []).map((o) => o.id));
  switch (attr.type) {
    case 'TEXT': {
      const max = typeof c['maxLength'] === 'number' ? c['maxLength'] : 100_000;
      return z.string().max(max);
    }
    case 'NUMBER': {
      let s = z.number().finite();
      if (typeof c['min'] === 'number') s = s.min(c['min']);
      if (typeof c['max'] === 'number') s = s.max(c['max']);
      return s;
    }
    case 'CURRENCY':
      return z.number().finite();
    case 'DATE':
      return z
        .string()
        .regex(DATE_ONLY, 'must be YYYY-MM-DD')
        .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');
    case 'DATETIME':
      return isoDateTime;
    case 'SELECT':
    case 'STATUS': {
      const ids = optionIds(c['options']);
      return z.string().refine((v) => ids.has(v), 'not one of the options');
    }
    case 'MULTISELECT': {
      const ids = optionIds(c['options']);
      return z.array(z.string().refine((v) => ids.has(v), 'not one of the options')).max(200);
    }
    case 'BOOLEAN':
      return z.boolean();
    case 'EMAIL':
      return z.email().max(320).toLowerCase();
    case 'PHONE':
      return z.string().regex(E164, 'must be E.164, e.g. +14155552671');
    case 'URL':
      return z.url().max(2048);
    case 'RATING': {
      const max = typeof c['max'] === 'number' ? c['max'] : 5;
      return z.number().int().min(0).max(max);
    }
    case 'RELATIONSHIP':
      return c['multiple'] === true
        ? z.array(z.string().uuid()).max(500)
        : z.array(z.string().uuid()).max(1);
    case 'USER':
      return c['multiple'] === true
        ? z.array(z.string().uuid()).max(100)
        : z.array(z.string().uuid()).max(1);
    case 'LOCATION':
      return locationSchema;
    case 'SOCIAL_HANDLE':
      return z
        .string()
        .regex(HANDLE, 'must be a handle like @name')
        .transform((s) => (s.startsWith('@') ? s : `@${s}`));
    case 'AI_RESEARCH':
      return aiResearchValueSchema;
    case 'FORMULA':
    case 'ROLLUP':
      return z.never();
  }
}

export type FieldError = { attributeId: string; apiSlug: string; message: string };

export type ValidatedValues = {
  /** Values keyed by attribute id, null meaning "clear". */
  values: Record<string, unknown>;
};

/**
 * Validate a values payload keyed by attribute id OR apiSlug (both accepted on input; output is
 * keyed by id). `mode: 'create'` enforces required attributes; `'update'` validates only the keys
 * present (null clears). Unknown keys are rejected; `_unmapped` is passed through untouched.
 */
export function validateRecordValues(
  attributes: readonly AttributeDef[],
  input: Record<string, unknown>,
  mode: 'create' | 'update',
): Result<ValidatedValues> {
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const bySlug = new Map(attributes.map((a) => [a.apiSlug, a]));
  const errors: FieldError[] = [];
  const values: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(input)) {
    if (key === '_unmapped') {
      values['_unmapped'] = raw;
      continue;
    }
    const attr = byId.get(key) ?? bySlug.get(key);
    if (!attr) {
      errors.push({ attributeId: key, apiSlug: key, message: 'unknown attribute' });
      continue;
    }
    if (COMPUTED_TYPES.has(attr.type)) {
      errors.push({
        attributeId: attr.id,
        apiSlug: attr.apiSlug,
        message: `${attr.type} attributes are computed and cannot be written`,
      });
      continue;
    }
    if (raw === null || raw === undefined || raw === '') {
      values[attr.id] = null;
      continue;
    }
    const r = valueSchema(attr).safeParse(raw);
    if (!r.success) {
      errors.push({
        attributeId: attr.id,
        apiSlug: attr.apiSlug,
        message: r.error.issues[0]?.message ?? 'invalid value',
      });
      continue;
    }
    values[attr.id] = r.data;
  }

  for (const attr of attributes) {
    if (!attr.isRequired || COMPUTED_TYPES.has(attr.type)) continue;
    const present = attr.id in values && values[attr.id] !== null;
    if (mode === 'create' && !present) {
      errors.push({ attributeId: attr.id, apiSlug: attr.apiSlug, message: 'required' });
    } else if (mode === 'update' && attr.id in values && values[attr.id] === null) {
      errors.push({ attributeId: attr.id, apiSlug: attr.apiSlug, message: 'required' });
    }
  }

  if (errors.length > 0) {
    return err(
      new NexusError('VALIDATION', {
        context: {
          reason:
            errors.length === 1
              ? `${errors[0]!.apiSlug}: ${errors[0]!.message}`
              : `${errors.length} fields are invalid.`,
          detail: 'Correct the highlighted fields and try again.',
        },
        details: { fields: errors },
      }),
    );
  }
  return ok({ values });
}

/**
 * Parse a CSV cell into a typed value for `attr`. Returns `undefined` for an empty cell, a typed
 * value, or an Error message. Used by the import preview and run.
 */
export function coerceCell(
  attr: AttributeDef,
  cell: string,
): { value: unknown } | { error: string } | { empty: true } {
  const text = cell.trim();
  if (text === '') return { empty: true };
  const opts = Array.isArray(attr.config['options']) ? (attr.config['options'] as Option[]) : [];
  const findOption = (t: string) =>
    opts.find((o) => o.id === t || o.label.toLowerCase() === t.toLowerCase())?.id;
  let candidate: unknown = text;
  switch (attr.type) {
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING': {
      const cleaned = text.replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '');
      const n = cleaned === '' ? Number.NaN : Number(cleaned);
      if (Number.isNaN(n)) return { error: 'not a number' };
      candidate = n;
      break;
    }
    case 'BOOLEAN': {
      const t = text.toLowerCase();
      if (['true', 'yes', 'y', '1', 'on'].includes(t)) candidate = true;
      else if (['false', 'no', 'n', '0', 'off'].includes(t)) candidate = false;
      else return { error: 'not a yes/no value' };
      break;
    }
    case 'DATE': {
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return { error: 'not a date' };
      candidate = DATE_ONLY.test(text) ? text : d.toISOString().slice(0, 10);
      break;
    }
    case 'DATETIME': {
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return { error: 'not a date-time' };
      candidate = d.toISOString();
      break;
    }
    case 'SELECT':
    case 'STATUS': {
      const id = findOption(text);
      if (!id) return { error: `"${text}" is not one of the options` };
      candidate = id;
      break;
    }
    case 'MULTISELECT': {
      const ids = text
        .split(/[;|,]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map(findOption);
      if (ids.some((i) => !i)) return { error: 'contains a value that is not one of the options' };
      candidate = ids;
      break;
    }
    case 'RELATIONSHIP':
    case 'USER':
      candidate = text
        .split(/[;|,]/)
        .map((t) => t.trim())
        .filter(Boolean);
      break;
    case 'LOCATION':
      candidate = { address: text };
      break;
    default:
      candidate = text;
  }
  const r = valueSchema(attr).safeParse(candidate);
  return r.success ? { value: r.data } : { error: r.error.issues[0]?.message ?? 'invalid value' };
}

// ── filter DSL ────────────────────────────────────────────────────────────────

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
  'hasAny',
  'hasAll',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const TEXTUAL: FilterOp[] = [
  'eq',
  'neq',
  'contains',
  'startsWith',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
];
const ORDERED: FilterOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
];
const SETLIKE: FilterOp[] = ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty'];

/** Operators valid for an attribute type (the query builder rejects anything else). */
export function filterOpsFor(type: AttributeType): readonly FilterOp[] {
  switch (type) {
    case 'TEXT':
    case 'EMAIL':
    case 'PHONE':
    case 'URL':
    case 'SOCIAL_HANDLE':
      return TEXTUAL;
    case 'SELECT':
    case 'STATUS':
      return ['eq', 'neq', 'in', 'notIn', 'isEmpty', 'isNotEmpty'];
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING':
    case 'DATE':
    case 'DATETIME':
      return ORDERED;
    case 'BOOLEAN':
      return ['eq', 'isEmpty', 'isNotEmpty'];
    case 'MULTISELECT':
    case 'RELATIONSHIP':
    case 'USER':
      return SETLIKE;
    case 'LOCATION':
    case 'AI_RESEARCH':
      return ['isEmpty', 'isNotEmpty'];
    case 'FORMULA':
    case 'ROLLUP':
      return ORDERED;
  }
}

export const filterSchema = z.object({
  /** attribute id or apiSlug; or a system column: `createdAt`, `updatedAt` */
  attribute: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});
export type Filter = z.infer<typeof filterSchema>;

export const sortSchema = z.object({
  attribute: z.string().min(1),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
export type Sort = z.infer<typeof sortSchema>;

export const recordQuerySchema = z.object({
  filters: z.array(filterSchema).max(20).default([]),
  sort: z.array(sortSchema).max(3).default([]),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  includeDeleted: z.boolean().default(false),
});
export type RecordQuery = z.infer<typeof recordQuerySchema>;
