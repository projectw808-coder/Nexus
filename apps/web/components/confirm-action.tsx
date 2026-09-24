'use client';

import { useActionState, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/button';
import { InlineNotice } from '@/components/error-state';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

/**
 * A destructive button with an inline confirm step (no `window.confirm`). The first click
 * reveals the question and Confirm/Cancel; Confirm submits the server action. The result
 * sentence renders next to the control.
 */
export function ConfirmAction({
  label,
  question,
  confirmLabel,
  action,
  disabled,
  disabledReason,
  size = 'sm',
}: {
  label: string;
  question: ReactNode;
  confirmLabel: string;
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  disabled?: boolean;
  disabledReason?: string;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  const id = useId();

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="danger"
          size={size}
          onClick={() => setOpen(true)}
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          aria-describedby={disabled && disabledReason ? `${id}-why` : undefined}
        >
          {label}
        </Button>
        {disabled && disabledReason ? (
          <span id={`${id}-why`} className="sr-only">
            {disabledReason}
          </span>
        ) : null}
        {!state.ok ? <InlineNotice tone="critical">{state.message}</InlineNotice> : null}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      role="group"
      aria-labelledby={`${id}-q`}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <span id={`${id}-q`} className="text-[var(--text-sm)] text-ink-secondary">
        {question}
      </span>
      <Button variant="secondary" size={size} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <FormSubmit variant="danger" size={size} pendingText="Working…">
        {confirmLabel}
      </FormSubmit>
      {!state.ok ? (
        <div className="basis-full">
          <InlineNotice tone="critical">
            {state.message}
            {state.remediation ? ` ${state.remediation}` : ''}
          </InlineNotice>
        </div>
      ) : null}
    </form>
  );
}
