'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { AttributeInput } from '@/components/attribute-input';
import { buttonClass } from '@/components/button';
import { InlineNotice } from '@/components/error-state';
import { FormSubmit } from '@/components/form-submit';
import type { SearchRecords } from '@/components/record-search';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { AttributeLike, ObjectTypeRef } from '@/lib/attributes';

/**
 * The generic create/edit form: one `AttributeInput` per visible attribute, in position order.
 * Field errors from the server (`details.fields`) are keyed by apiSlug and land on the input.
 */
export function RecordForm({
  action,
  attributes,
  initial,
  slug,
  objectTypes,
  searches,
  submitLabel,
  pendingLabel,
  cancelHref,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  attributes: AttributeLike[];
  /** Current values keyed by attribute id (the API's shape). */
  initial: Record<string, unknown>;
  slug: string;
  objectTypes: ObjectTypeRef[];
  searches?: Record<string, SearchRecords>;
  submitLabel: string;
  pendingLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const fields = state.ok ? undefined : state.fields;

  return (
    <form action={formAction} noValidate className="flex max-w-2xl flex-col gap-5">
      {attributes.map((a) => (
        <AttributeInput
          key={a.id}
          attribute={a}
          value={initial[a.id]}
          error={fields?.[a.apiSlug] ?? null}
          slug={slug}
          objectTypes={objectTypes}
          searches={searches}
        />
      ))}
      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation && !state.fields ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
      <div className="flex items-center gap-3 border-t border-hairline pt-4">
        <FormSubmit pendingText={pendingLabel}>{submitLabel}</FormSubmit>
        <Link href={cancelHref} className={buttonClass('ghost')}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
