'use client';

/**
 * The attribute panel of a record (§12.2.B): inline-editable values (field-level permissions
 * respected), and a per-field history popover fed by the audit trail.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CellEditor, isInlineEditable } from '@/components/data-grid/cell-editor';
import { ValueCell } from '@/components/value-cell';
import type { AttributeLike } from '@/lib/attributes';
import { useTRPC } from '@/lib/trpc-client';

export function AttributePanel({
  slug,
  recordId,
  attributes,
  initialValues,
  canEdit,
}: {
  slug: string;
  recordId: string;
  attributes: AttributeLike[];
  initialValues: Record<string, unknown>;
  canEdit: boolean;
}) {
  const trpc = useTRPC();
  const [values, setValues] = useState(initialValues);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useMutation(
    trpc.record.update.mutationOptions({ onError: (e) => setNotice(e.message) }),
  );

  const commit = (attr: AttributeLike, next: unknown) => {
    setEditing(null);
    const prev = values[attr.id];
    setValues((v) => ({ ...v, [attr.id]: next }));
    update.mutate(
      { id: recordId, values: { [attr.id]: next } },
      {
        onSuccess: (r) => setValues(r.values),
        onError: () => setValues((v) => ({ ...v, [attr.id]: prev })),
      },
    );
  };

  return (
    <div className="flex flex-col">
      {notice ? (
        <p role="alert" className="mb-2 text-[var(--text-sm)] text-critical">
          {notice}{' '}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      ) : null}
      <dl className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
        {attributes.map((a) => {
          const editable = canEdit && isInlineEditable(a);
          return (
            <div
              key={a.id}
              className="grid grid-cols-[minmax(8rem,1fr)_2fr] items-center gap-3 px-3 py-1.5 text-[var(--text-sm)]"
            >
              <dt className="truncate text-ink-secondary" title={a.description ?? undefined}>
                {a.title}
              </dt>
              <dd className="relative flex min-h-8 items-center gap-2">
                <div className="min-w-0 flex-1">
                  {editing === a.id ? (
                    <CellEditor
                      attr={a}
                      value={values[a.id]}
                      onCommit={(v) => commit(a, v)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : editable ? (
                    <button
                      type="button"
                      onClick={() => setEditing(a.id)}
                      className="flex min-h-8 w-full items-center rounded-[var(--radius-control)] px-1 text-left hover:bg-raised focus-visible:shadow-[var(--focus-ring)]"
                      aria-label={`Edit ${a.title}`}
                    >
                      <ValueCell attribute={a} value={values[a.id]} slug={slug} full />
                    </button>
                  ) : (
                    <span className="flex min-h-8 items-center px-1">
                      <ValueCell attribute={a} value={values[a.id]} slug={slug} full />
                    </span>
                  )}
                </div>
                <HistoryPopover recordId={recordId} attribute={a} />
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function HistoryPopover({ recordId, attribute }: { recordId: string; attribute: AttributeLike }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const history = useQuery({
    ...trpc.record.history.queryOptions({ id: recordId, limit: 100 }),
    enabled: open,
  });
  const changes = (history.data ?? [])
    .map((h) => {
      const d = h.diff[attribute.id] as { from?: unknown; to?: unknown } | undefined;
      const created =
        h.action === 'record.created'
          ? (h.diff['values'] as Record<string, unknown> | undefined)?.[attribute.id]
          : undefined;
      if (d && typeof d === 'object') return { at: h.at, actor: h.actor, from: d.from, to: d.to };
      if (created !== undefined) return { at: h.at, actor: h.actor, from: null, to: created };
      return null;
    })
    .filter((x): x is { at: Date; actor: string; from: unknown; to: unknown } => x !== null);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`History of ${attribute.title}`}
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1 text-[var(--text-xs)] text-ink-muted hover:text-ink focus-visible:shadow-[var(--focus-ring)]"
      >
        ⏱
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={`${attribute.title} history`}
          className="absolute right-0 top-6 z-20 w-72 rounded-[var(--radius-card)] border border-hairline bg-raised p-2 text-[var(--text-xs)] shadow-[var(--elevation-2)]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          {history.isPending ? (
            <p className="text-ink-muted">Loading…</p>
          ) : changes.length === 0 ? (
            <p className="text-ink-muted">No recorded changes.</p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-auto">
              {changes.map((c, i) => (
                <li key={i} className="border-b border-hairline pb-1 last:border-0">
                  <div className="text-ink-muted">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(c.at)}{' '}
                    · {c.actor}
                  </div>
                  <div className="truncate">
                    <span className="line-through text-ink-muted">{fmt(c.from)}</span> →{' '}
                    <span>{fmt(c.to)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="mt-1 underline" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}
