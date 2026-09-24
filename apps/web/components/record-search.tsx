'use client';

import { useId, useState, useTransition } from 'react';
import { Button } from '@/components/button';
import { InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS } from '@/components/field';
import { isUuid } from '@/lib/attributes';

export type SearchHit = { id: string; label: string };
export type SearchResult = { ok: true; items: SearchHit[] } | { ok: false; message: string };
/** A bound server action: `searchRecordsAction.bind(null, slug, objectTypeRef)`. */
export type SearchRecords = (q: string) => Promise<SearchResult>;

/**
 * A small server-driven picker: type, press Find (or Enter), pick a row. The search runs as a
 * server action against `record.query` with `search`, so there is no client-side tRPC.
 */
export function RecordSearch({
  search,
  onPick,
  label,
  placeholder,
  exclude,
}: {
  search: SearchRecords;
  onPick: (hit: SearchHit) => void;
  label: string;
  placeholder?: string;
  exclude?: ReadonlySet<string>;
}) {
  const id = useId();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    const term = q.trim();
    if (!term) return;
    startTransition(async () => {
      setResult(await search(term));
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={id} className="text-[var(--text-sm)] font-medium">
            {label}
          </label>
          <input
            id={id}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              }
            }}
            placeholder={placeholder ?? 'Search by name…'}
            className={CONTROL_CLASS}
            autoComplete="off"
          />
        </div>
        <Button
          variant="secondary"
          onClick={run}
          disabled={pending || !q.trim()}
          aria-busy={pending || undefined}
        >
          {pending ? 'Finding…' : 'Find'}
        </Button>
      </div>
      {result && !result.ok ? <InlineNotice tone="critical">{result.message}</InlineNotice> : null}
      {result?.ok ? (
        result.items.length === 0 ? (
          <p role="status" className="text-[var(--text-sm)] text-ink-muted">
            Nothing matches “{q.trim()}”.
          </p>
        ) : (
          <ul
            role="listbox"
            aria-label="Matching records"
            className="max-h-56 divide-y divide-[var(--border-hairline)] overflow-y-auto rounded-[var(--radius-control)] border border-hairline bg-raised"
          >
            {result.items.map((hit) => {
              const taken = exclude?.has(hit.id) ?? false;
              return (
                <li key={hit.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    disabled={taken}
                    onClick={() => onPick(hit)}
                    className="flex h-9 w-full items-center justify-between gap-3 px-3 text-left text-[var(--text-sm)] hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="truncate">{hit.label}</span>
                    <span className="shrink-0 font-mono text-[var(--text-xs)] text-ink-muted">
                      {taken ? 'added' : hit.id.slice(0, 8)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * RELATIONSHIP / USER input: the chosen ids as removable chips, a paste box for raw ids, and —
 * when a search action is available for the target object — the picker above. Submits a single
 * comma-separated hidden input under `name`.
 */
export function RelationshipPicker({
  name,
  inputId,
  initial,
  multiple,
  search,
  targetLabel,
  disabled,
  describedBy,
  invalid,
}: {
  name: string;
  inputId: string;
  initial: string[];
  multiple: boolean;
  search?: SearchRecords;
  targetLabel: string;
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [ids, setIds] = useState<string[]>(initial);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);

  const add = (id: string) => {
    if (!id) return;
    setIds((prev) => (multiple ? (prev.includes(id) ? prev : [...prev, id]) : [id]));
  };
  const addDraft = () => {
    const parts = draft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) add(p);
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={ids.join(',')} />
      {ids.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Linked ${targetLabel}`}>
          {ids.map((id) => (
            <li
              key={id}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-pill)] border border-hairline bg-card pl-2.5 pr-1 font-mono text-[var(--text-xs)]"
            >
              <span title={id}>{id.slice(0, 8)}</span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => setIds((prev) => prev.filter((x) => x !== id))}
                  aria-label={`Remove ${id}`}
                  className="flex size-5 items-center justify-center rounded-[var(--radius-pill)] hover:bg-raised"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--text-sm)] text-ink-muted">Nothing linked.</p>
      )}
      {!disabled ? (
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraft();
              }
            }}
            placeholder={multiple ? 'Paste record ids, comma-separated' : 'Paste a record id'}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={`${CONTROL_CLASS} font-mono text-[var(--text-sm)]`}
            spellCheck={false}
          />
          <Button
            variant="secondary"
            onClick={addDraft}
            disabled={!draft.trim() || !isUuid(draft.trim().split(/[,\s]+/)[0] ?? '')}
          >
            Add id
          </Button>
          {search ? (
            <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? 'Hide search' : `Find ${targetLabel.toLowerCase()}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {search && open && !disabled ? (
        <div className="rounded-[var(--radius-card)] border border-hairline bg-card p-3">
          <RecordSearch
            search={search}
            label={`Search ${targetLabel.toLowerCase()}`}
            onPick={(hit) => add(hit.id)}
            exclude={new Set(ids)}
          />
        </div>
      ) : null}
    </div>
  );
}
