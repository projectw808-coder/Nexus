'use client';

import { useEffect, useRef, useState } from 'react';
import type { AttributeLike } from '@/lib/attributes';
import { optionsOf, ratingMaxOf } from '@/lib/attributes';

const EDITABLE = new Set([
  'TEXT',
  'EMAIL',
  'URL',
  'PHONE',
  'SOCIAL_HANDLE',
  'NUMBER',
  'CURRENCY',
  'RATING',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'SELECT',
  'STATUS',
  'MULTISELECT',
]);

export function isInlineEditable(attr: Pick<AttributeLike, 'type' | 'access'>): boolean {
  return attr.access === 'WRITE' && EDITABLE.has(attr.type);
}

const INPUT =
  'h-full w-full rounded-[var(--radius-control)] border border-link bg-raised px-2 text-[var(--text-sm)] text-ink outline-none';

/**
 * Inline cell editor. Commits on Enter / blur / change (for selects and checkboxes), cancels on
 * Escape. The parent owns the mutation and the optimistic value; this only produces a typed
 * value or `null` (clear).
 */
export function CellEditor({
  attr,
  value,
  onCommit,
  onCancel,
}: {
  attr: AttributeLike;
  value: unknown;
  onCommit: (next: unknown) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (ref.current instanceof HTMLInputElement && ref.current.type === 'text')
      ref.current.select();
  }, []);

  const onKey = (e: React.KeyboardEvent, commit: () => void) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Tab') {
      commit();
    } else {
      e.stopPropagation();
    }
  };

  switch (attr.type) {
    case 'BOOLEAN':
      return (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="checkbox"
          aria-label={attr.title}
          defaultChecked={value === true}
          onChange={(e) => onCommit(e.target.checked)}
          onKeyDown={(e) => onKey(e, () => onCommit((e.target as HTMLInputElement).checked))}
          onBlur={onCancel}
          className="m-2"
        />
      );
    case 'SELECT':
    case 'STATUS':
      return (
        <select
          ref={ref as React.RefObject<HTMLSelectElement>}
          aria-label={attr.title}
          defaultValue={typeof value === 'string' ? value : ''}
          onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
          onKeyDown={(e) => onKey(e, () => onCommit((e.target as HTMLSelectElement).value || null))}
          onBlur={onCancel}
          className={INPUT}
        >
          <option value="">—</option>
          {optionsOf(attr.config).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'MULTISELECT':
      return (
        <MultiSelectEditor
          attr={attr}
          value={Array.isArray(value) ? (value as string[]) : []}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING': {
      const max = attr.type === 'RATING' ? ratingMaxOf(attr.config) : undefined;
      return (
        <NumberEditor
          inputRef={ref as React.RefObject<HTMLInputElement>}
          title={attr.title}
          value={typeof value === 'number' ? value : null}
          max={max}
          onCommit={onCommit}
          onKey={onKey}
          onCancel={onCancel}
        />
      );
    }
    case 'DATE':
      return (
        <TextEditor
          inputRef={ref as React.RefObject<HTMLInputElement>}
          type="date"
          title={attr.title}
          value={typeof value === 'string' ? value : ''}
          onCommit={(s) => onCommit(s === '' ? null : s)}
          onKey={onKey}
          onCancel={onCancel}
        />
      );
    case 'DATETIME':
      return (
        <TextEditor
          inputRef={ref as React.RefObject<HTMLInputElement>}
          type="datetime-local"
          title={attr.title}
          value={typeof value === 'string' && value ? toLocalInput(value) : ''}
          onCommit={(s) => onCommit(s === '' ? null : new Date(s).toISOString())}
          onKey={onKey}
          onCancel={onCancel}
        />
      );
    default:
      return (
        <TextEditor
          inputRef={ref as React.RefObject<HTMLInputElement>}
          type={attr.type === 'EMAIL' ? 'email' : attr.type === 'URL' ? 'url' : 'text'}
          title={attr.title}
          value={typeof value === 'string' ? value : ''}
          onCommit={(s) => onCommit(s === '' ? null : s)}
          onKey={onKey}
          onCancel={onCancel}
        />
      );
  }
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TextEditor({
  inputRef,
  type,
  title,
  value,
  onCommit,
  onKey,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  type: string;
  title: string;
  value: string;
  onCommit: (s: string) => void;
  onKey: (e: React.KeyboardEvent, commit: () => void) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    if (v === value) onCancel();
    else onCommit(v);
  };
  return (
    <input
      ref={inputRef}
      type={type}
      aria-label={title}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => onKey(e, commit)}
      onBlur={commit}
      className={INPUT}
    />
  );
}

function NumberEditor({
  inputRef,
  title,
  value,
  max,
  onCommit,
  onKey,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  title: string;
  value: number | null;
  max: number | undefined;
  onCommit: (n: unknown) => void;
  onKey: (e: React.KeyboardEvent, commit: () => void) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value === null ? '' : String(value));
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    if (v.trim() === '') return value === null ? onCancel() : onCommit(null);
    const n = Number(v);
    if (Number.isNaN(n) || n === value) return onCancel();
    onCommit(n);
  };
  return (
    <input
      ref={inputRef}
      type="number"
      inputMode="decimal"
      aria-label={title}
      value={v}
      min={max !== undefined ? 0 : undefined}
      max={max}
      step="any"
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => onKey(e, commit)}
      onBlur={commit}
      className={`${INPUT} tnum`}
    />
  );
}

function MultiSelectEditor({
  attr,
  value,
  onCommit,
  onCancel,
}: {
  attr: AttributeLike;
  value: string[];
  onCommit: (v: unknown) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(new Set(value));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  const commit = () => onCommit(selected.size === 0 ? null : [...selected]);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={attr.title}
      className="absolute left-0 top-0 z-20 flex min-w-full flex-col gap-1 rounded-[var(--radius-control)] border border-link bg-raised p-2 text-[var(--text-sm)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else e.stopPropagation();
      }}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget)) commit();
      }}
    >
      {optionsOf(attr.config).map((o) => (
        <label key={o.id} className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected.has(o.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(o.id);
              else next.delete(o.id);
              setSelected(next);
            }}
          />
          {o.label}
        </label>
      ))}
      <span className="text-[var(--text-xs)] text-ink-muted">Enter to apply, Esc to cancel</span>
    </div>
  );
}
