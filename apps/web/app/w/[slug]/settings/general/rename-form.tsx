'use client';

import { useActionState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { Field, Input } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

export function RenameForm({
  action,
  initialName,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  initialName: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const nameError = state.ok ? null : (state.fields?.name ?? null);

  return (
    <form action={formAction} noValidate className="flex max-w-lg flex-col gap-4">
      <Field
        id="name"
        label="Workspace name"
        error={nameError}
        hint="Shown in the top bar and in invitations."
      >
        <Input
          id="name"
          name="name"
          defaultValue={initialName}
          error={nameError}
          hint
          required
          minLength={2}
          maxLength={80}
        />
      </Field>
      <div className="flex items-center gap-3">
        <FormSubmit pendingText="Saving…">Save</FormSubmit>
        {state.ok && state.message ? (
          <InlineNotice tone="good">{state.message}</InlineNotice>
        ) : null}
        {!state.ok && !state.fields ? (
          <InlineNotice tone="critical">
            {state.message}
            {state.remediation ? ` ${state.remediation}` : ''}
          </InlineNotice>
        ) : null}
      </div>
    </form>
  );
}
