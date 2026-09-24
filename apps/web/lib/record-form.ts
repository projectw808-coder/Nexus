/**
 * Maps a record form's `FormData` to the values payload `record.create`/`update` accept (keyed
 * by apiSlug; the API also accepts ids). Inputs are named `v_<apiSlug>` (LOCATION sub-fields
 * `v_<apiSlug>__<part>`). Only writable, non-computed attributes are read — the server
 * validates again, this is the shape, not the rule.
 */
import type { AttributeLike } from '@/lib/attributes';
import { isComputed } from '@/lib/attributes';

export function fieldName(apiSlug: string, part?: string): string {
  return part ? `v_${apiSlug}__${part}` : `v_${apiSlug}`;
}

export const LOCATION_PARTS = ['address', 'city', 'region', 'country', 'postalCode'] as const;

function str(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  return typeof v === 'string' ? v.trim() : null;
}

function ids(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function valuesFromForm(
  attributes: readonly AttributeLike[],
  formData: FormData,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const a of attributes) {
    if (isComputed(a.type) || a.access === 'READ') continue;
    const name = fieldName(a.apiSlug);
    switch (a.type) {
      case 'BOOLEAN': {
        // The form always carries the checkbox (absent → false); the hidden `<name>__present`
        // input tells us the field was rendered at all.
        if (formData.get(`${name}__present`) === null) break;
        values[a.apiSlug] = formData.get(name) === 'on';
        break;
      }
      case 'NUMBER':
      case 'CURRENCY':
      case 'RATING': {
        const s = str(formData, name);
        if (s === null) break;
        if (s === '') {
          values[a.apiSlug] = null;
          break;
        }
        const n = Number(s.replace(/,/g, ''));
        values[a.apiSlug] = Number.isNaN(n) ? s : n;
        break;
      }
      case 'DATETIME': {
        const s = str(formData, name);
        if (s === null) break;
        if (s === '') {
          values[a.apiSlug] = null;
          break;
        }
        const d = new Date(s);
        values[a.apiSlug] = Number.isNaN(d.getTime()) ? s : d.toISOString();
        break;
      }
      case 'MULTISELECT': {
        if (formData.get(`${name}__present`) === null) break;
        const picked = formData.getAll(name).filter((v): v is string => typeof v === 'string');
        values[a.apiSlug] = picked.length ? picked : null;
        break;
      }
      case 'RELATIONSHIP':
      case 'USER': {
        const s = str(formData, name);
        if (s === null) break;
        const list = ids(s);
        values[a.apiSlug] = list.length ? list : null;
        break;
      }
      case 'LOCATION': {
        const parts: Record<string, string> = {};
        let any = false;
        for (const p of LOCATION_PARTS) {
          const s = str(formData, fieldName(a.apiSlug, p));
          if (s === null) continue;
          any = true;
          if (s !== '') parts[p] = p === 'country' ? s.toUpperCase() : s;
        }
        if (!any) break;
        values[a.apiSlug] = Object.keys(parts).length ? parts : null;
        break;
      }
      default: {
        const s = str(formData, name);
        if (s === null) break;
        values[a.apiSlug] = s === '' ? null : s;
      }
    }
  }
  return values;
}
