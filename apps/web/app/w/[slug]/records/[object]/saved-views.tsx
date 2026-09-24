'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useId } from 'react';
import { InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS, Field, Input } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { IDLE, type ActionState } from '@/lib/action-state';

export type ViewOption = {
  id: string;
  name: string;
  href: string;
  isShared: boolean;
  isMine: boolean;
};

/**
 * Saved views (§6.6): a `<select>` that navigates to the view's URL, and a small "save current
 * view" form. The current DSL travels as hidden JSON so the action does not re-derive it.
 */
export function SavedViews({
  views,
  currentHref,
  baseHref,
  filtersJson,
  sortsJson,
  canShare,
  canSave,
  saveAction,
}: {
  views: ViewOption[];
  currentHref: string;
  baseHref: string;
  filtersJson: string;
  sortsJson: string;
  canShare: boolean;
  canSave: boolean;
  saveAction: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const router = useRouter();
  const id = useId();
  const [state, formAction] = useActionState(saveAction, IDLE);
  const nameError = state.ok ? null : (state.fields?.name ?? null);
  const selected = views.find((v) => v.href === currentHref)?.id ?? '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-view`} className="sr-only">
        Saved view
      </label>
      <select
        id={`${id}-view`}
        value={selected}
        onChange={(e) => {
          const v = views.find((x) => x.id === e.target.value);
          router.push(v ? v.href : baseHref);
        }}
        className={`${CONTROL_CLASS} w-52`}
      >
        <option value="">All records</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.isShared ? ' · shared' : v.isMine ? '' : ''}
          </option>
        ))}
      </select>
      {canSave ? (
        <details className="relative">
          <summary className="inline-flex h-[var(--control-height)] cursor-pointer list-none items-center rounded-[var(--radius-control)] border border-hairline bg-card px-3 text-[var(--text-sm)] font-medium hover:border-strong [&::-webkit-details-marker]:hidden">
            Save current view
          </summary>
          <form
            action={formAction}
            noValidate
            className="absolute left-0 top-[calc(100%+4px)] z-20 flex w-72 flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-raised p-3"
          >
            <input type="hidden" name="filters" value={filtersJson} />
            <input type="hidden" name="sorts" value={sortsJson} />
            <Field id={`${id}-name`} label="Name" error={nameError}>
              <Input
                id={`${id}-name`}
                name="name"
                error={nameError}
                required
                maxLength={80}
                placeholder="Open deals in EMEA"
              />
            </Field>
            {canShare ? (
              <label className="inline-flex items-center gap-2 text-[var(--text-sm)]">
                <input type="checkbox" name="shared" />
                Share with the workspace
              </label>
            ) : (
              <p className="text-[var(--text-xs)] text-ink-muted">
                Private to you. Admins can share views.
              </p>
            )}
            <div className="flex items-center gap-2">
              <FormSubmit size="sm" pendingText="Saving…">
                Save
              </FormSubmit>
            </div>
            {state.ok && state.message ? (
              <InlineNotice tone="good">{state.message}</InlineNotice>
            ) : null}
            {!state.ok && !state.fields ? (
              <InlineNotice tone="critical">
                {state.message}
                {state.remediation ? ` ${state.remediation}` : ''}
              </InlineNotice>
            ) : null}
          </form>
        </details>
      ) : null}
    </div>
  );
}
