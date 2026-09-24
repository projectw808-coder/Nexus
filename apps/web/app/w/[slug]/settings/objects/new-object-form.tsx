'use client';

import { useActionState, useState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { Field, Input } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ATTRIBUTE_SLUG_HELP, isValidIdentifier, slugifyIdentifier } from '@/lib/attributes';

/** Singular → plural and slug follow along until edited by hand. */
export function NewObjectForm({
  action,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [singular, setSingular] = useState('');
  const [plural, setPlural] = useState('');
  const [slug, setSlug] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const fields = state.ok ? undefined : state.fields;
  const slugError =
    fields?.apiSlug ?? (slug && !isValidIdentifier(slug) ? ATTRIBUTE_SLUG_HELP : null);

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="obj-singular" label="Singular" error={fields?.singular ?? null}>
          <Input
            id="obj-singular"
            name="singular"
            value={singular}
            onChange={(e) => {
              setSingular(e.target.value);
              if (!pluralTouched) setPlural(e.target.value ? `${e.target.value}s` : '');
              if (!slugTouched) setSlug(slugifyIdentifier(e.target.value));
            }}
            error={fields?.singular ?? null}
            required
            maxLength={60}
            placeholder="Project"
          />
        </Field>
        <Field id="obj-plural" label="Plural" error={fields?.plural ?? null}>
          <Input
            id="obj-plural"
            name="plural"
            value={plural}
            onChange={(e) => {
              setPluralTouched(true);
              setPlural(e.target.value);
            }}
            error={fields?.plural ?? null}
            required
            maxLength={60}
            placeholder="Projects"
          />
        </Field>
        <Field id="obj-slug" label="API slug" error={slugError} hint={ATTRIBUTE_SLUG_HELP}>
          <Input
            id="obj-slug"
            name="apiSlug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            error={slugError}
            hint
            required
            spellCheck={false}
            autoCapitalize="none"
            className="font-mono"
            placeholder="project"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field id="obj-icon" label="Icon (optional)" hint="A short icon name, e.g. folder.">
          <Input id="obj-icon" name="icon" hint maxLength={40} />
        </Field>
        <Field id="obj-description" label="Description (optional)">
          <Input id="obj-description" name="description" maxLength={500} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <FormSubmit pendingText="Creating…" disabled={!singular || !plural || !slug || !!slugError}>
          Create object
        </FormSubmit>
        <span className="text-[var(--text-sm)] text-ink-muted">
          Every object starts with a required Name attribute.
        </span>
      </div>
      {!state.ok && !state.fields ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
    </form>
  );
}
