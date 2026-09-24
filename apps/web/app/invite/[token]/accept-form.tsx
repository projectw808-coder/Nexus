'use client';

import { useActionState } from 'react';
import { InlineNotice } from '@/components/error-state';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

export function AcceptForm({
  action,
  workspaceName,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  workspaceName: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormSubmit pendingText="Joining…" className="self-start">
        Accept and join {workspaceName}
      </FormSubmit>
      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
    </form>
  );
}
