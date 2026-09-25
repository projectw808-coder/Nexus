'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { platformName } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Reply = RouterOutputs['cannedReply']['list'][number];

export function CannedRepliesView({
  initial,
  canEdit,
  canDelete,
}: {
  initial: Reply[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery({ ...trpc.cannedReply.list.queryOptions({}), initialData: initial });
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.cannedReply.list.pathKey() });
  const create = useMutation(
    trpc.cannedReply.create.mutationOptions({
      onSuccess: () => {
        invalidate();
        setTitle('');
        setBody('');
        setShortcut('');
      },
    }),
  );
  const remove = useMutation(trpc.cannedReply.delete.mutationOptions({ onSuccess: invalidate }));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [shortcut, setShortcut] = useState('');
  const error = create.error ?? remove.error;

  return (
    <div className="flex flex-col gap-6">
      {canEdit ? (
        <form
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !body.trim()) return;
            create.mutate({
              title: title.trim(),
              body: body.trim(),
              shortcut: shortcut.trim() || null,
            });
          }}
        >
          <h2 className="text-[var(--text-md)] font-semibold tracking-tight">New canned reply</h2>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={80}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Shortcut <span className="text-ink-muted">(type /shortcut in the composer)</span>
            <input
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              maxLength={32}
              pattern="[A-Za-z0-9_-]*"
              className="w-48 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 font-mono text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Body
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={4}
              maxLength={8000}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-ink"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending || !title.trim() || !body.trim()}
            >
              {create.isPending ? 'Saving…' : 'Save reply'}
            </Button>
            {error ? (
              <span role="alert" className="text-[var(--text-sm)] text-critical">
                {error.message}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
      <section aria-labelledby="replies-heading" className="flex flex-col gap-3">
        <h2 id="replies-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Saved replies{' '}
          <span className="tnum font-normal text-ink-muted">({list.data.length})</span>
        </h2>
        {list.data.length === 0 ? (
          <EmptyState
            compact
            title="No canned replies yet"
            description="Save the answers you type most; they appear in the composer under “Canned replies” and as /shortcuts."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {list.data.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 px-4 py-2.5 text-[var(--text-sm)]">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="font-medium">{r.title}</span>
                  {r.shortcut ? (
                    <span className="font-mono text-[var(--text-xs)] text-ink-muted">
                      /{r.shortcut}
                    </span>
                  ) : null}
                  {r.platform ? (
                    <span className="text-[var(--text-xs)] text-ink-muted">
                      {platformName(r.platform)} only
                    </span>
                  ) : null}
                  {canDelete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => remove.mutate({ id: r.id })}
                      disabled={remove.isPending}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap text-ink-secondary">{r.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
