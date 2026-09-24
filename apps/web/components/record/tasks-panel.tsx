'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { CONTROL_CLASS } from '@/components/field';
import { Skeleton } from '@/components/skeleton';
import { StatusPill } from '@/components/status-pill';
import { useTRPC } from '@/lib/trpc-client';

export function TasksPanel({ recordId, canWrite }: { recordId: string; canWrite: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const input = { recordId, includeDone: showDone };
  const key = trpc.task.list.queryKey(input);
  const tasks = useQuery(trpc.task.list.queryOptions(input));
  const invalidate = () =>
    void qc
      .invalidateQueries({ queryKey: trpc.task.list.queryKey({ recordId, includeDone: false }) })
      .then(() => qc.invalidateQueries({ queryKey: key }));
  const create = useMutation(trpc.task.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.task.update.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.task.delete.mutationOptions({ onSuccess: invalidate }));
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  return (
    <section aria-labelledby="tasks-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="tasks-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Tasks{' '}
          {tasks.data ? (
            <span className="tnum font-normal text-ink-muted">({tasks.data.length})</span>
          ) : null}
        </h2>
        <label className="inline-flex items-center gap-2 text-[var(--text-xs)] text-ink-secondary">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />{' '}
          Show done
        </label>
      </div>
      {canWrite ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            const t = title.trim();
            const d = due;
            setTitle('');
            setDue('');
            create.mutate(
              { recordId, title: t, dueAt: d ? new Date(d) : null },
              {
                onError: () => {
                  setTitle(t);
                  setDue(d);
                },
              },
            );
          }}
        >
          <div className="min-w-48 flex-1">
            <label htmlFor="task-title" className="sr-only">
              Task
            </label>
            <input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a task…"
              className={CONTROL_CLASS}
            />
          </div>
          <div>
            <label htmlFor="task-due" className="sr-only">
              Due
            </label>
            <input
              id="task-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className={`${CONTROL_CLASS} w-auto`}
            />
          </div>
          <Button type="submit" size="md" disabled={create.isPending || !title.trim()}>
            Add
          </Button>
          {create.isError ? (
            <span role="alert" className="basis-full text-[var(--text-sm)] text-critical">
              {create.error.message}
            </span>
          ) : null}
        </form>
      ) : null}
      {tasks.isPending ? (
        <Skeleton className="h-12" />
      ) : tasks.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {tasks.error.message}
        </p>
      ) : tasks.data.length === 0 ? (
        <EmptyState
          compact
          title="No open tasks"
          description={
            canWrite
              ? 'Add one above to keep the next step visible.'
              : 'Nothing is scheduled on this record.'
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card text-[var(--text-sm)]">
          {tasks.data.map((t) => {
            const done = t.status === 'DONE' || t.status === 'CANCELLED';
            return (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`Mark ${t.title} ${done ? 'open' : 'done'}`}
                  checked={done}
                  disabled={!canWrite}
                  onChange={(e) =>
                    update.mutate({ id: t.id, status: e.target.checked ? 'DONE' : 'OPEN' })
                  }
                />
                <span
                  className={`min-w-0 flex-1 truncate ${done ? 'text-ink-muted line-through' : ''}`}
                >
                  {t.title}
                </span>
                {t.priority !== 'NORMAL' ? (
                  <StatusPill
                    tone={
                      t.priority === 'URGENT'
                        ? 'critical'
                        : t.priority === 'HIGH'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {t.priority.toLowerCase()}
                  </StatusPill>
                ) : null}
                {t.dueAt ? (
                  <span
                    className={`tnum text-[var(--text-xs)] ${t.overdue ? 'text-critical' : 'text-ink-muted'}`}
                  >
                    {t.overdue ? 'overdue · ' : ''}
                    {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(t.dueAt)}
                  </span>
                ) : null}
                {t.assignee ? (
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    {t.assignee.name ?? t.assignee.email}
                  </span>
                ) : null}
                {canWrite ? (
                  <button
                    type="button"
                    className="text-[var(--text-xs)] text-ink-muted underline"
                    onClick={() => remove.mutate({ id: t.id })}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
