'use client';

import { useActionState, useState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS, describedBy, Field, Input, Select } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { ObjectTypeRef } from '@/lib/attributes';

export function NewListForm({
  action,
  objectTypes,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  objectTypes: ObjectTypeRef[];
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [kind, setKind] = useState<'PIPELINE' | 'COLLECTION'>('PIPELINE');
  const fields = state.ok ? undefined : state.fields;
  const stagesError = fields?.stages ?? null;

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_12rem]">
        <Field id="list-name" label="Name" error={fields?.name ?? null}>
          <Input
            id="list-name"
            name="name"
            error={fields?.name ?? null}
            required
            maxLength={80}
            placeholder="Sales pipeline"
          />
        </Field>
        <Field id="list-object" label="Object" error={fields?.objectType ?? null}>
          <Select
            id="list-object"
            name="objectType"
            error={fields?.objectType ?? null}
            defaultValue={
              objectTypes.find((o) => o.apiSlug === 'deal')?.apiSlug ??
              objectTypes[0]?.apiSlug ??
              ''
            }
          >
            {objectTypes.map((o) => (
              <option key={o.id} value={o.apiSlug}>
                {o.plural}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id="list-kind"
          label="Kind"
          error={fields?.kind ?? null}
          hint={kind === 'PIPELINE' ? 'Stages, a board, stage history.' : 'A flat set of records.'}
        >
          <Select
            id="list-kind"
            name="kind"
            hint
            value={kind}
            onChange={(e) => setKind(e.target.value === 'COLLECTION' ? 'COLLECTION' : 'PIPELINE')}
          >
            <option value="PIPELINE">Pipeline</option>
            <option value="COLLECTION">Collection</option>
          </Select>
        </Field>
      </div>
      {kind === 'PIPELINE' ? (
        <Field
          id="list-stages"
          label="Stages"
          hint="One per line, in order. The first stage is where new entries land."
          error={stagesError}
        >
          <textarea
            id="list-stages"
            name="stages"
            rows={4}
            required
            defaultValue={'Lead\nQualified\nProposal\nWon\nLost'}
            aria-invalid={stagesError ? true : undefined}
            aria-describedby={describedBy('list-stages', { hint: true, error: !!stagesError })}
            className={`${CONTROL_CLASS} h-auto max-w-md py-2`}
          />
        </Field>
      ) : null}
      <Field id="list-description" label="Description (optional)">
        <Input id="list-description" name="description" maxLength={500} />
      </Field>
      <div className="flex items-center gap-3">
        <FormSubmit pendingText="Creating…">Create list</FormSubmit>
        {!state.ok ? (
          <InlineNotice tone="critical">
            {state.message}
            {state.remediation && !state.fields ? ` ${state.remediation}` : ''}
          </InlineNotice>
        ) : null}
      </div>
    </form>
  );
}
