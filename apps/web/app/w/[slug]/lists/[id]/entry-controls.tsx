'use client';

import { useActionState, useId, useState, useTransition } from 'react';
import type { Option } from '@nexus/core';
import { InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS, Field, Select } from '@/components/field';
import { FormSubmit } from '@/components/form-submit';
import { LocalDateTime } from '@/components/local-time';
import { RecordSearch, type SearchHit, type SearchRecords } from '@/components/record-search';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { HistoryResult } from './actions';

/** Per-card stage `<select>` that submits on change (a `<noscript>` button keeps it usable without JS). */
export function StageSelect({
  action,
  stage,
  stages,
  entryLabel,
  disabled,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  stage: string | null;
  stages: Option[];
  entryLabel: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="sr-only">
          Stage for {entryLabel}
        </label>
        <select
          id={id}
          name="stage"
          key={stage ?? ''}
          defaultValue={stage ?? ''}
          disabled={disabled || pending}
          aria-busy={pending || undefined}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className={`${CONTROL_CLASS} h-7 text-[var(--text-xs)]`}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <noscript>
          <button
            type="submit"
            className="h-7 rounded-[var(--radius-control)] border border-hairline px-2 text-[var(--text-xs)]"
          >
            Move
          </button>
        </noscript>
      </div>
      {!state.ok ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
    </form>
  );
}

/** Stage history in a `<details>`; fetched the first time it opens. */
export function EntryHistory({
  load,
  stages,
}: {
  load: () => Promise<HistoryResult>;
  stages: Option[];
}) {
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [pending, startTransition] = useTransition();
  const stageLabel = (id: string | null) =>
    id ? (stages.find((s) => s.id === id)?.label ?? id) : '—';
  return (
    <details
      className="text-[var(--text-xs)]"
      onToggle={(e) => {
        if (e.currentTarget.open && result === null && !pending) {
          startTransition(async () => {
            setResult(await load());
          });
        }
      }}
    >
      <summary className="cursor-pointer text-ink-muted hover:text-ink">History</summary>
      <div className="mt-1.5" aria-busy={pending || undefined}>
        {pending && result === null ? <p className="text-ink-muted">Loading…</p> : null}
        {result && !result.ok ? (
          <InlineNotice tone="critical">{result.message}</InlineNotice>
        ) : null}
        {result?.ok ? (
          result.items.length === 0 ? (
            <p className="text-ink-muted">No stage changes yet.</p>
          ) : (
            <ol className="flex flex-col gap-1 border-l border-hairline pl-2.5">
              {result.items.map((h) => (
                <li key={h.id} className="text-ink-secondary">
                  <span className="font-medium text-ink">
                    {h.fromStage ? `${stageLabel(h.fromStage)} → ` : ''}
                    {stageLabel(h.toStage)}
                  </span>
                  <span className="ml-1.5 text-ink-muted">
                    <LocalDateTime iso={h.at} />
                    {h.by ? ` · ${h.by}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </div>
    </details>
  );
}

/** "Add record": search, pick, choose a stage (pipelines), submit `listEntry.add`. */
export function AddEntryForm({
  action,
  search,
  stages,
  objectLabel,
  existing,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  search: SearchRecords;
  stages: Option[];
  objectLabel: string;
  existing: ReadonlySet<string>;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [picked, setPicked] = useState<SearchHit | null>(null);
  const fields = state.ok ? undefined : state.fields;
  return (
    <form
      action={formAction}
      noValidate
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <RecordSearch
        search={search}
        label={`Find a ${objectLabel.toLowerCase()}`}
        onPick={setPicked}
        exclude={existing}
      />
      <input type="hidden" name="recordId" value={picked?.id ?? ''} />
      <div className="flex flex-wrap items-end gap-3">
        <p className="flex-1 text-[var(--text-sm)]" aria-live="polite">
          {picked ? (
            <>
              Selected: <span className="font-medium">{picked.label}</span>{' '}
              <button
                type="button"
                onClick={() => setPicked(null)}
                className="text-ink-muted underline-offset-2 hover:underline"
              >
                change
              </button>
            </>
          ) : (
            <span className={fields?.recordId ? 'text-critical' : 'text-ink-muted'}>
              {fields?.recordId ?? 'Nothing selected yet.'}
            </span>
          )}
        </p>
        {stages.length > 0 ? (
          <Field id="add-stage" label="Stage">
            <Select id="add-stage" name="stage" defaultValue={stages[0]?.id} className="w-44">
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <FormSubmit pendingText="Adding…" disabled={!picked}>
          Add to list
        </FormSubmit>
      </div>
      {state.ok && state.message ? <InlineNotice tone="good">{state.message}</InlineNotice> : null}
      {!state.ok && !state.fields ? (
        <InlineNotice tone="critical">
          {state.message}
          {state.remediation ? ` ${state.remediation}` : ''}
        </InlineNotice>
      ) : null}
    </form>
  );
}
