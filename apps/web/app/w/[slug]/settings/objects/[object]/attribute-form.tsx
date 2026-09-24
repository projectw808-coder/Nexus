'use client';

import type { AttributeType } from '@nexus/core';
import { useActionState, useState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { Field, Input, Select } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  ATTRIBUTE_SLUG_HELP,
  CREATABLE_TYPES,
  TYPE_LABEL,
  isIndexable,
  isValidIdentifier,
  slugifyIdentifier,
  type ObjectTypeRef,
} from '@/lib/attributes';

/**
 * Add an attribute: title → slug follows until edited; the type picks which configuration
 * fields appear. The migration preview line comes from the server (record count), so the
 * person sees what a new column or an index touches before they submit (§12.2.F).
 */
export function AttributeForm({
  action,
  objectTypes,
  recordCount,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  objectTypes: ObjectTypeRef[];
  recordCount: number;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [type, setType] = useState<AttributeType>('TEXT');
  const [indexed, setIndexed] = useState(false);
  const fields = state.ok ? undefined : state.fields;
  const slugError =
    fields?.apiSlug ?? (slug && !isValidIdentifier(slug) ? ATTRIBUTE_SLUG_HELP : null);
  const indexable = isIndexable(type);

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="attr-title" label="Title" error={fields?.title ?? null}>
          <Input
            id="attr-title"
            name="title"
            value={title}
            required
            maxLength={80}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(slugifyIdentifier(e.target.value));
            }}
            error={fields?.title ?? null}
          />
        </Field>
        <Field
          id="attr-slug"
          label="API slug"
          hint="Used in the API and CSV headers."
          error={slugError}
        >
          <Input
            id="attr-slug"
            name="apiSlug"
            value={slug}
            required
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            error={slugError}
            className="font-mono"
          />
        </Field>
        <Field id="attr-type" label="Type" error={fields?.type ?? null}>
          <Select
            id="attr-type"
            name="type"
            value={type}
            onChange={(e) => {
              const next = e.target.value as AttributeType;
              setType(next);
              if (!isIndexable(next)) setIndexed(false);
            }}
          >
            {CREATABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <TypeConfig type={type} objectTypes={objectTypes} />

      <Field id="attr-description" label="Description" hint="Shown as help text on forms.">
        <Input id="attr-description" name="description" maxLength={500} />
      </Field>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[var(--text-sm)]">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" name="isRequired" /> Required
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" name="isUnique" /> Unique
        </label>
        <label
          className={`inline-flex items-center gap-2 ${indexable ? '' : 'opacity-50'}`}
          title={indexable ? undefined : `${TYPE_LABEL[type]} attributes cannot be indexed.`}
        >
          <input
            type="checkbox"
            name="isIndexed"
            checked={indexed}
            disabled={!indexable}
            onChange={(e) => setIndexed(e.target.checked)}
          />{' '}
          Indexed
          <span className="text-ink-muted">(fast filter and sort)</span>
        </label>
      </div>

      <p className="text-[var(--text-sm)] text-ink-secondary" role="status">
        {indexed
          ? `This will add a column and an index for ${recordCount.toLocaleString()} ${recordCount === 1 ? 'record' : 'records'}, built in the background. `
          : `This will add a field to ${recordCount.toLocaleString()} ${recordCount === 1 ? 'record' : 'records'}. `}
        Deleting an attribute later is reversible for 24 hours.
      </p>

      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : state.message ? (
        <InlineNotice tone="good">{state.message}</InlineNotice>
      ) : null}

      <div>
        <FormSubmit pendingText="Adding…">Add attribute</FormSubmit>
      </div>
    </form>
  );
}

function TypeConfig({ type, objectTypes }: { type: AttributeType; objectTypes: ObjectTypeRef[] }) {
  switch (type) {
    case 'SELECT':
    case 'MULTISELECT':
    case 'STATUS':
      return (
        <Field
          id="attr-options"
          label="Options"
          hint="One per line. Optionally add a colour after a pipe, e.g. Won | #0ca30c"
        >
          <textarea
            id="attr-options"
            name="options"
            rows={4}
            required
            className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-[var(--text-base)] text-ink hover:border-strong"
          />
        </Field>
      );
    case 'CURRENCY':
      return (
        <Field id="attr-currency" label="Currency code" hint="ISO 4217, e.g. USD, EUR.">
          <Input
            id="attr-currency"
            name="currency"
            defaultValue="USD"
            maxLength={3}
            className="font-mono uppercase"
          />
        </Field>
      );
    case 'RATING':
      return (
        <Field id="attr-max" label="Maximum">
          <Input id="attr-max" name="max" type="number" defaultValue={5} min={1} max={10} />
        </Field>
      );
    case 'RELATIONSHIP':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="attr-target" label="Related object">
            <Select id="attr-target" name="targetObjectTypeId" required>
              {objectTypes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.plural}
                </option>
              ))}
            </Select>
          </Field>
          <label className="inline-flex items-center gap-2 self-end pb-2 text-[var(--text-sm)]">
            <input type="checkbox" name="multiple" /> Allow several
          </label>
        </div>
      );
    case 'USER':
      return (
        <label className="inline-flex items-center gap-2 text-[var(--text-sm)]">
          <input type="checkbox" name="multiple" /> Allow several people
        </label>
      );
    case 'TEXT':
      return (
        <label className="inline-flex items-center gap-2 text-[var(--text-sm)]">
          <input type="checkbox" name="multiline" /> Multi-line
        </label>
      );
    default:
      return null;
  }
}
