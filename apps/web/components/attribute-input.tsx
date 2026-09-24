'use client';

import { Field, Input, Select, CONTROL_CLASS, describedBy } from '@/components/field';
import { RelationshipPicker, type SearchRecords } from '@/components/record-search';
import { ValueCell } from '@/components/value-cell';
import {
  currencyOf,
  isComputed,
  isMultiline,
  isMultiple,
  optionsOf,
  ratingMaxOf,
  targetObjectTypeIdOf,
  swatchColor,
  TYPE_LABEL,
  type AttributeLike,
  type ObjectTypeRef,
} from '@/lib/attributes';
import { fieldName, LOCATION_PARTS } from '@/lib/record-form';

const LOCATION_LABEL: Record<(typeof LOCATION_PARTS)[number], string> = {
  address: 'Address',
  city: 'City',
  region: 'Region',
  country: 'Country (2 letters)',
  postalCode: 'Postal code',
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * One form control per attribute type (§6.2). Computed and read-only attributes render their
 * value instead of a control; required attributes carry `required`; the error sentence sits
 * under the control with `aria-describedby`. Inputs are named by `fieldName(apiSlug)` so the
 * server can map them back with `valuesFromForm`.
 */
export function AttributeInput({
  attribute,
  value,
  error,
  slug,
  objectTypes,
  searches,
}: {
  attribute: AttributeLike;
  value: unknown;
  error?: string | null;
  slug: string;
  objectTypes: ObjectTypeRef[];
  /** Bound search actions keyed by target object type id (RELATIONSHIP pickers). */
  searches?: Record<string, SearchRecords>;
}) {
  const a = attribute;
  const id = `attr-${a.apiSlug}`;
  const name = fieldName(a.apiSlug);
  const readOnly = a.access === 'READ' || isComputed(a.type);
  const label = (
    <>
      {a.title}
      {a.isRequired && !readOnly ? (
        <span aria-hidden className="ml-1 text-critical">
          *
        </span>
      ) : null}
      <span className="ml-2 text-[var(--text-xs)] font-normal text-ink-muted">
        {TYPE_LABEL[a.type]}
      </span>
    </>
  );
  const hint = a.description ?? undefined;

  if (readOnly) {
    return (
      <Field
        id={id}
        label={label}
        hint={
          hint ??
          (isComputed(a.type) ? 'Computed by Nexus; not editable.' : 'Read-only for your role.')
        }
      >
        <div
          id={id}
          className="flex min-h-[var(--control-height)] items-center rounded-[var(--radius-control)] border border-dashed border-hairline px-3 text-[var(--text-base)]"
        >
          <ValueCell attribute={a} value={value} slug={slug} full />
        </div>
      </Field>
    );
  }

  const err = error ?? null;
  const common = { id, name, error: err, hint: !!hint, required: a.isRequired } as const;

  switch (a.type) {
    case 'TEXT':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          {isMultiline(a.config) ? (
            <textarea
              id={id}
              name={name}
              defaultValue={asString(value)}
              rows={4}
              required={a.isRequired}
              aria-invalid={err ? true : undefined}
              aria-describedby={describedBy(id, { hint: !!hint, error: !!err })}
              className={`${CONTROL_CLASS} h-auto py-2`}
            />
          ) : (
            <Input {...common} type="text" defaultValue={asString(value)} />
          )}
        </Field>
      );
    case 'EMAIL':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <Input {...common} type="email" inputMode="email" defaultValue={asString(value)} />
        </Field>
      );
    case 'URL':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <Input
            {...common}
            type="url"
            inputMode="url"
            placeholder="https://"
            defaultValue={asString(value)}
          />
        </Field>
      );
    case 'PHONE':
      return (
        <Field
          id={id}
          label={label}
          hint={hint ?? 'International format, e.g. +14155552671.'}
          error={err}
        >
          <Input {...common} hint type="tel" inputMode="tel" defaultValue={asString(value)} />
        </Field>
      );
    case 'SOCIAL_HANDLE':
      return (
        <Field id={id} label={label} hint={hint ?? 'A handle like @name.'} error={err}>
          <Input {...common} hint type="text" defaultValue={asString(value)} />
        </Field>
      );
    case 'NUMBER':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <Input
            {...common}
            type="number"
            inputMode="decimal"
            step="any"
            defaultValue={asString(value)}
            className="tnum"
          />
        </Field>
      );
    case 'CURRENCY':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[var(--text-sm)] text-ink-muted">
              {currencyOf(a.config)}
            </span>
            <Input
              {...common}
              type="number"
              inputMode="decimal"
              step="any"
              defaultValue={asString(value)}
              className="tnum"
            />
          </div>
        </Field>
      );
    case 'RATING': {
      const max = ratingMaxOf(a.config);
      return (
        <Field id={id} label={label} hint={hint ?? `0 to ${max}.`} error={err}>
          <Input
            {...common}
            hint
            type="number"
            inputMode="numeric"
            min={0}
            max={max}
            step={1}
            defaultValue={asString(value)}
            className="tnum w-24"
          />
        </Field>
      );
    }
    case 'DATE':
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <Input {...common} type="date" defaultValue={asString(value)} className="w-56" />
        </Field>
      );
    case 'DATETIME': {
      const iso = asString(value);
      const local = iso ? iso.slice(0, 16) : '';
      return (
        <Field id={id} label={label} hint={hint ?? 'Stored as UTC.'} error={err}>
          <Input {...common} hint type="datetime-local" defaultValue={local} className="w-64" />
        </Field>
      );
    }
    case 'SELECT':
    case 'STATUS': {
      const options = optionsOf(a.config);
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <Select {...common} defaultValue={asString(value)}>
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case 'MULTISELECT': {
      const options = optionsOf(a.config);
      const chosen = new Set(idList(value));
      return (
        <Field id={id} label={label} hint={hint} error={err}>
          <fieldset
            id={id}
            aria-describedby={describedBy(id, { hint: !!hint, error: !!err })}
            aria-invalid={err ? true : undefined}
            className="flex flex-wrap gap-x-4 gap-y-2 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2"
          >
            <legend className="sr-only">{a.title}</legend>
            <input type="hidden" name={`${name}__present`} value="1" />
            {options.length === 0 ? (
              <span className="text-[var(--text-sm)] text-ink-muted">No options configured.</span>
            ) : null}
            {options.map((o, i) => (
              <label key={o.id} className="inline-flex items-center gap-2 text-[var(--text-sm)]">
                <input type="checkbox" name={name} value={o.id} defaultChecked={chosen.has(o.id)} />
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full border border-hairline"
                  style={{ background: swatchColor(o, i) }}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        </Field>
      );
    }
    case 'BOOLEAN':
      return (
        <div className="flex flex-col gap-1.5">
          <input type="hidden" name={`${name}__present`} value="1" />
          <label
            htmlFor={id}
            className="inline-flex items-center gap-2 text-[var(--text-sm)] font-medium"
          >
            <input
              id={id}
              type="checkbox"
              name={name}
              defaultChecked={value === true}
              aria-describedby={describedBy(id, { hint: !!hint, error: !!err })}
            />
            {label}
          </label>
          {err ? (
            <p id={`${id}-error`} role="alert" className="text-[var(--text-sm)] text-critical">
              {err}
            </p>
          ) : hint ? (
            <p id={`${id}-hint`} className="text-[var(--text-sm)] text-ink-muted">
              {hint}
            </p>
          ) : null}
        </div>
      );
    case 'RELATIONSHIP': {
      const targetId = targetObjectTypeIdOf(a.config);
      const target = objectTypes.find((o) => o.id === targetId);
      const targetLabel = target
        ? isMultiple(a.config)
          ? target.plural
          : target.singular
        : 'records';
      return (
        <Field
          id={id}
          label={label}
          hint={hint ?? (target ? `Links to ${target.plural.toLowerCase()}.` : undefined)}
          error={err}
        >
          <RelationshipPicker
            name={name}
            inputId={id}
            initial={idList(value)}
            multiple={isMultiple(a.config)}
            search={targetId ? searches?.[targetId] : undefined}
            targetLabel={targetLabel}
            describedBy={describedBy(id, { hint: true, error: !!err })}
            invalid={!!err}
          />
        </Field>
      );
    }
    case 'USER':
      return (
        <Field
          id={id}
          label={label}
          hint={hint ?? 'Member user ids, comma-separated. A people picker comes with Phase 3.'}
          error={err}
        >
          <RelationshipPicker
            name={name}
            inputId={id}
            initial={idList(value)}
            multiple={isMultiple(a.config)}
            targetLabel="users"
            describedBy={describedBy(id, { hint: true, error: !!err })}
            invalid={!!err}
          />
        </Field>
      );
    case 'LOCATION': {
      const loc = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      return (
        <fieldset className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3">
          <legend className="px-1 text-[var(--text-sm)] font-medium">{label}</legend>
          {hint ? <p className="text-[var(--text-sm)] text-ink-muted">{hint}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {LOCATION_PARTS.map((p) => {
              const pid = `${id}-${p}`;
              return (
                <Field
                  key={p}
                  id={pid}
                  label={LOCATION_LABEL[p]}
                  className={p === 'address' ? 'sm:col-span-2' : ''}
                >
                  <Input
                    id={pid}
                    name={fieldName(a.apiSlug, p)}
                    type="text"
                    defaultValue={asString(loc[p])}
                    maxLength={p === 'country' ? 2 : undefined}
                  />
                </Field>
              );
            })}
          </div>
          {err ? (
            <p role="alert" className="text-[var(--text-sm)] text-critical">
              {err}
            </p>
          ) : null}
        </fieldset>
      );
    }
    case 'AI_RESEARCH':
    case 'FORMULA':
    case 'ROLLUP':
      return null; // handled by `readOnly` above
  }
}
