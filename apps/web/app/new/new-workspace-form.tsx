'use client';

import { useActionState, useState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { Field, Input } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';
import { isValidSlug, SLUG_HELP, slugify } from '@/lib/slug';

/**
 * Name + slug. The slug follows the name until the user edits it by hand; inline validation
 * mirrors the server rule, and the server's answer (e.g. CONFLICT) lands on the right field.
 */
export function NewWorkspaceForm({
  action,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const serverFields = state.ok ? undefined : state.fields;
  const slugLocalError = slug.length > 0 && !isValidSlug(slug) ? SLUG_HELP : null;
  const slugError = serverFields?.slug ?? slugLocalError;
  const nameError = serverFields?.name ?? null;

  return (
    <form action={formAction} noValidate className="flex max-w-lg flex-col gap-5">
      <Field
        id="name"
        label="Name"
        error={nameError}
        hint="Shown in the top bar and in invitations."
      >
        <Input
          id="name"
          name="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          error={nameError}
          hint
          required
          minLength={2}
          maxLength={80}
          autoComplete="organization"
          autoFocus
        />
      </Field>

      <Field
        id="slug"
        label="Slug"
        error={slugError}
        hint={`Used in the address: /w/${slug || 'your-slug'}. ${SLUG_HELP}`}
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[var(--text-sm)] text-ink-muted">/w/</span>
          <Input
            id="slug"
            name="slug"
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
          />
        </div>
      </Field>

      {!state.ok && !state.fields ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}

      <div className="flex items-center gap-3">
        <FormSubmit pendingText="Creating…" disabled={!name || !slug || !!slugLocalError}>
          Create workspace
        </FormSubmit>
        <span className="text-[var(--text-sm)] text-ink-muted">You will be the owner.</span>
      </div>
    </form>
  );
}
