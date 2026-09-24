'use client';

import { useActionState, useId } from 'react';
import type { Role } from '@nexus/db';
import { InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS } from '@/components/field';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ROLE_LABEL, ROLES } from '@/lib/roles';

/**
 * Role `<select>` that submits its form on change. Options outside `assignable` are disabled;
 * the whole control is disabled for the current user and for members whose role the current
 * user may not touch. A `<noscript>` Save button keeps it usable without JavaScript.
 */
export function MemberRoleSelect({
  action,
  role,
  assignable,
  disabled,
  disabledReason,
  memberLabel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  role: Role;
  assignable: readonly Role[];
  disabled: boolean;
  disabledReason?: string;
  memberLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const id = useId();

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Role for {memberLabel}
        </label>
        <select
          id={id}
          name="role"
          key={role}
          defaultValue={role}
          disabled={disabled || pending}
          aria-busy={pending || undefined}
          aria-describedby={disabled && disabledReason ? `${id}-why` : undefined}
          title={disabled ? disabledReason : undefined}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className={`${CONTROL_CLASS} w-36`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r} disabled={!assignable.includes(r) && r !== role}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <noscript>
          <button
            type="submit"
            className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-hairline px-2 text-[var(--text-sm)]"
          >
            Save
          </button>
        </noscript>
      </div>
      {disabled && disabledReason ? (
        <span id={`${id}-why`} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
      {state.ok && state.message ? <InlineNotice tone="good">{state.message}</InlineNotice> : null}
      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
    </form>
  );
}
