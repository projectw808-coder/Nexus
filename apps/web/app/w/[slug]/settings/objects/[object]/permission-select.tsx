'use client';

import type { Role } from '@nexus/db';
import { useActionState, useId, useRef } from 'react';
import { CONTROL_CLASS } from '@/components/field';
import { IDLE, type ActionState } from '@/lib/action-state';

const LEVELS = [
  { value: 'default', label: 'Default' },
  { value: 'HIDDEN', label: 'Hidden' },
  { value: 'READ', label: 'Read' },
  { value: 'WRITE', label: 'Write' },
] as const;

/** Field-level permission for one role: submits on change, with a no-JS Save fallback. */
export function PermissionSelect({
  role,
  current,
  action,
}: {
  role: Role;
  current: string | null;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const ref = useRef<HTMLFormElement>(null);
  const id = useId();
  return (
    <form ref={ref} action={formAction} className="inline-flex items-center gap-1">
      <input type="hidden" name="role" value={role} />
      <label htmlFor={id} className="sr-only">
        {role.toLowerCase()} access
      </label>
      <select
        id={id}
        name="access"
        defaultValue={current ?? 'default'}
        onChange={() => ref.current?.requestSubmit()}
        className={`${CONTROL_CLASS} h-7 w-auto px-2 text-[var(--text-xs)]`}
        aria-invalid={!state.ok || undefined}
        title={!state.ok ? state.message : undefined}
      >
        {LEVELS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="text-[var(--text-xs)] underline">
          Save
        </button>
      </noscript>
    </form>
  );
}
