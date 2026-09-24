'use client';

import { useActionState } from 'react';
import type { ButtonSize, ButtonVariant } from '@/components/button';
import { InlineNotice } from '@/components/error-state';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

/**
 * A single-button form for a non-destructive server action (restore, toggle, move). Shows the
 * pending state and the result sentence inline. Destructive actions use `ConfirmAction`.
 */
export function ActionButton({
  action,
  children,
  pendingText,
  variant = 'secondary',
  size = 'sm',
  hidden,
  disabled,
  title,
  className = '',
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  pendingText: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Hidden inputs the action reads from `formData`. */
  hidden?: Record<string, string>;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <form action={formAction} className={`inline-flex flex-col items-start gap-1 ${className}`}>
      {hidden
        ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)
        : null}
      <span title={title}>
        <FormSubmit variant={variant} size={size} pendingText={pendingText} disabled={disabled}>
          {children}
        </FormSubmit>
      </span>
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
