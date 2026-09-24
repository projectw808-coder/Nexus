'use client';

import { useActionState } from 'react';
import type { Role } from '@nexus/db';
import { InlineNotice } from '@/components/error-state';
import { Field, Input, Select } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/lib/roles';

export function InviteForm({
  action,
  assignable,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  assignable: readonly Role[];
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const fields = state.ok ? undefined : state.fields;
  const defaultRole: Role = assignable.includes('MEMBER') ? 'MEMBER' : (assignable[0] ?? 'VIEWER');

  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field id="invite-email" label="Email" error={fields?.email ?? null}>
          <Input
            id="invite-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="colleague@example.com"
            error={fields?.email ?? null}
            required
          />
        </Field>
        <Field id="invite-role" label="Role" error={fields?.role ?? null}>
          <Select
            id="invite-role"
            name="role"
            defaultValue={defaultRole}
            error={fields?.role ?? null}
          >
            {assignable.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <FormSubmit pendingText="Sending…">Send invitation</FormSubmit>
      </div>
      <details className="text-[var(--text-sm)] text-ink-muted">
        <summary className="cursor-pointer">What each role can do</summary>
        <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1">
          {assignable.map((r) => (
            <div key={r} className="contents">
              <dt className="text-ink-secondary">{ROLE_LABEL[r]}</dt>
              <dd>{ROLE_DESCRIPTION[r]}</dd>
            </div>
          ))}
        </dl>
      </details>
      {state.ok && state.message ? <InlineNotice tone="good">{state.message}</InlineNotice> : null}
      {!state.ok && !state.fields ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
      {!state.ok && state.fields ? (
        <InlineNotice tone="critical">{state.message}</InlineNotice>
      ) : null}
    </form>
  );
}
