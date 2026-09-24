'use client';

import { useActionState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { Field } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

export function UploadForm({
  action,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const fields = state.ok ? undefined : state.fields;
  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <Field
        id="csv-file"
        label="CSV file"
        hint="Comma, semicolon or tab separated, with a header row. Up to 8 MB and 50,000 rows."
        error={fields?.file ?? null}
      >
        <input
          id="csv-file"
          name="file"
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          required
          className="block w-full text-[var(--text-sm)] file:mr-3 file:h-[var(--control-height)] file:rounded-[var(--radius-control)] file:border file:border-hairline file:bg-raised file:px-3 file:text-ink"
        />
      </Field>
      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
      <div>
        <FormSubmit pendingText="Reading file…">Upload and preview</FormSubmit>
      </div>
    </form>
  );
}
