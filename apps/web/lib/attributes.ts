/**
 * Client-safe attribute helpers: labels, config accessors and formatters shared by the value
 * cell, the record form and the objects admin. Pure — imports only the pure parts of
 * @nexus/core (no Prisma, no I/O).
 */
import { COMPUTED_TYPES, INDEXABLE_TYPES, type AttributeType, type Option } from '@nexus/core';

/** The structural subset of `PublicAttribute` the UI needs (server pages pass the real thing). */
export type AttributeLike = {
  id: string;
  apiSlug: string;
  title: string;
  description?: string | null;
  type: AttributeType;
  config: Record<string, unknown>;
  isRequired: boolean;
  isUnique?: boolean;
  isSystem?: boolean;
  access?: 'READ' | 'WRITE';
  position?: number;
};

export type ObjectTypeRef = { id: string; apiSlug: string; singular: string; plural: string };

export const TYPE_LABEL: Record<AttributeType, string> = {
  TEXT: 'Text',
  NUMBER: 'Number',
  CURRENCY: 'Currency',
  DATE: 'Date',
  DATETIME: 'Date and time',
  SELECT: 'Select',
  MULTISELECT: 'Multi-select',
  BOOLEAN: 'Checkbox',
  EMAIL: 'Email',
  PHONE: 'Phone',
  URL: 'URL',
  RATING: 'Rating',
  STATUS: 'Status',
  RELATIONSHIP: 'Relationship',
  USER: 'User',
  LOCATION: 'Location',
  SOCIAL_HANDLE: 'Social handle',
  AI_RESEARCH: 'AI research (computed)',
  FORMULA: 'Formula (computed)',
  ROLLUP: 'Rollup (computed)',
};

/** Types an admin can add from the UI, in menu order. Computed types arrive with Phase 10. */
export const CREATABLE_TYPES: readonly AttributeType[] = [
  'TEXT',
  'NUMBER',
  'CURRENCY',
  'DATE',
  'DATETIME',
  'SELECT',
  'MULTISELECT',
  'STATUS',
  'BOOLEAN',
  'EMAIL',
  'PHONE',
  'URL',
  'SOCIAL_HANDLE',
  'RATING',
  'RELATIONSHIP',
  'USER',
  'LOCATION',
];

export const OPTION_TYPES: ReadonlySet<AttributeType> = new Set([
  'SELECT',
  'MULTISELECT',
  'STATUS',
]);

export function isComputed(type: AttributeType): boolean {
  return COMPUTED_TYPES.has(type);
}

export function isIndexable(type: AttributeType): boolean {
  return INDEXABLE_TYPES.has(type);
}

/** Types the table can sort on (mirrors the query builder's rule: indexable column kinds). */
export function isSortable(type: AttributeType): boolean {
  return INDEXABLE_TYPES.has(type);
}

export function optionsOf(config: Record<string, unknown>): Option[] {
  const raw = config['options'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is Option =>
      !!o &&
      typeof o === 'object' &&
      typeof (o as { id?: unknown }).id === 'string' &&
      typeof (o as { label?: unknown }).label === 'string',
  );
}

export function optionLabel(config: Record<string, unknown>, id: unknown): string {
  if (typeof id !== 'string') return '';
  return optionsOf(config).find((o) => o.id === id)?.label ?? id;
}

export function currencyOf(config: Record<string, unknown>): string {
  const c = config['currency'];
  return typeof c === 'string' && c.length === 3 ? c.toUpperCase() : 'USD';
}

export function ratingMaxOf(config: Record<string, unknown>): number {
  const m = config['max'];
  return typeof m === 'number' && m >= 1 && m <= 10 ? m : 5;
}

export function targetObjectTypeIdOf(config: Record<string, unknown>): string | null {
  const t = config['targetObjectTypeId'];
  return typeof t === 'string' ? t : null;
}

export function isMultiple(config: Record<string, unknown>): boolean {
  return config['multiple'] === true;
}

export function isMultiline(config: Record<string, unknown>): boolean {
  return config['multiline'] === true;
}

/** Fixed locale so server and client render the same string (dates are the exception). */
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

export function formatCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${numberFormat.format(n)}`;
  }
}

/** Slug rule of the API: lowercase letters, digits and underscores, starting with a letter. */
export const ATTRIBUTE_SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const ATTRIBUTE_SLUG_HELP =
  '2–40 lowercase letters, digits or underscores, starting with a letter.';

export function slugifyIdentifier(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(s) ? s : s ? `a_${s}`.slice(0, 40) : '';
}

export function isValidIdentifier(s: string): boolean {
  return ATTRIBUTE_SLUG_RE.test(s);
}

/** Colour for an option swatch: the option's own colour when it is a CSS colour, else a series token. */
export function swatchColor(option: Option, index: number): string {
  const c = option.color?.trim();
  if (c && /^(#[0-9a-f]{3,8}|rgb|hsl|var\()/i.test(c)) return c;
  return `var(--series-${(index % 8) + 1})`;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
