'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/skeleton';
import { useTRPC } from '@/lib/trpc-client';

export function NotesPanel({ recordId, canWrite }: { recordId: string; canWrite: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const key = trpc.note.list.queryKey({ recordId });
  const notes = useQuery(trpc.note.list.queryOptions({ recordId }));
  const invalidate = () => void qc.invalidateQueries({ queryKey: key });
  const create = useMutation(trpc.note.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.note.update.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.note.delete.mutationOptions({ onSuccess: invalidate }));
  const [draft, setDraft] = useState('');

  return (
    <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
      <h2 id="notes-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
        Notes{' '}
        {notes.data ? (
          <span className="tnum font-normal text-ink-muted">({notes.data.length})</span>
        ) : null}
      </h2>
      {canWrite ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            const body = draft.trim();
            setDraft('');
            create.mutate({ recordId, body }, { onError: () => setDraft(body) });
          }}
        >
          <label htmlFor="note-draft" className="sr-only">
            New note
          </label>
          <textarea
            id="note-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Add a note… (Ctrl+Enter to save)"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter')
                e.currentTarget.form?.requestSubmit();
            }}
            className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-[var(--text-sm)] text-ink"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={create.isPending || !draft.trim()}>
              {create.isPending ? 'Saving…' : 'Add note'}
            </Button>
            {create.isError ? (
              <span role="alert" className="text-[var(--text-sm)] text-critical">
                {create.error.message}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
      {notes.isPending ? (
        <Skeleton className="h-16" />
      ) : notes.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {notes.error.message}
        </p>
      ) : notes.data.length === 0 ? (
        <EmptyState
          compact
          title="No notes yet"
          description={
            canWrite ? 'Write the first one above.' : 'Nothing has been noted on this record.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.data.map((n) => (
            <li
              key={n.id}
              className={`rounded-[var(--radius-card)] border bg-card p-3 text-[var(--text-sm)] ${n.pinned ? 'border-strong' : 'border-hairline'}`}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[var(--text-xs)] text-ink-muted">
                <span>
                  {n.author?.name ?? n.author?.email ?? 'someone'} ·{' '}
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(n.createdAt)}
                  {n.pinned ? ' · pinned' : ''}
                </span>
                {canWrite ? (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className="underline"
                      onClick={() => update.mutate({ id: n.id, pinned: !n.pinned })}
                    >
                      {n.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    {n.isMine ? (
                      <button
                        type="button"
                        className="underline"
                        onClick={() => remove.mutate({ id: n.id })}
                      >
                        Delete
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
