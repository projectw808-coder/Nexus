'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { LocalDateTime } from '@/components/local-time';
import { StatusPill } from '@/components/status-pill';
import { useTRPC } from '@/lib/trpc-client';
import { WorkflowForm, type WorkflowInitial } from '../workflow-form';

const RUN_TONE: Record<string, 'good' | 'critical' | 'warning' | 'neutral'> = {
  QUEUED: 'neutral',
  RUNNING: 'neutral',
  SUCCEEDED: 'good',
  FAILED: 'critical',
  CANCELLED: 'warning',
};

export function WorkflowView({
  slug,
  canManage,
  workflow,
}: {
  slug: string;
  canManage: boolean;
  workflow: WorkflowInitial & { enabled: boolean; version: number };
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dryRunDays, setDryRunDays] = useState(7);

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.workflow.pathKey() });
  const setEnabled = useMutation(
    trpc.workflow.setEnabled.mutationOptions({ onSuccess: invalidate }),
  );
  const del = useMutation(
    trpc.workflow.delete.mutationOptions({
      onSuccess: () => router.push(`/w/${slug}/automations`),
    }),
  );
  const rollback = useMutation(trpc.workflow.rollback.mutationOptions({ onSuccess: invalidate }));

  const dryRun = useQuery({
    ...trpc.workflow.dryRun.queryOptions({ id: workflow.id, days: dryRunDays }),
    enabled: false,
  });
  const runs = useQuery(trpc.workflow.runs.queryOptions({ id: workflow.id }));
  const versions = useQuery(trpc.workflow.versions.queryOptions({ id: workflow.id }));

  if (editing) {
    return (
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          ← Cancel editing
        </Button>
        <WorkflowForm slug={slug} workflow={workflow} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusPill tone={workflow.enabled ? 'good' : 'neutral'}>
              {workflow.enabled ? 'Enabled' : 'Disabled'}
            </StatusPill>
            <span className="text-[var(--text-xs)] text-ink-muted">Version {workflow.version}</span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => setEnabled.mutate({ id: workflow.id, enabled: !workflow.enabled })}
                disabled={setEnabled.isPending}
              >
                {workflow.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {confirmDelete ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => del.mutate({ id: workflow.id })}
                  disabled={del.isPending}
                >
                  {del.isPending ? 'Deleting…' : 'Confirm delete'}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[var(--text-sm)] sm:grid-cols-4">
          <div>
            <dt className="text-[var(--text-xs)] text-ink-muted">Trigger</dt>
            <dd className="font-mono text-[var(--text-xs)]">{workflow.trigger.type}</dd>
          </div>
          {workflow.trigger.platform ? (
            <div>
              <dt className="text-[var(--text-xs)] text-ink-muted">Platform</dt>
              <dd>{workflow.trigger.platform}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-[var(--text-xs)] text-ink-muted">Conditions</dt>
            <dd className="font-mono text-[var(--text-xs)]">
              {Array.isArray(workflow.conditions) && workflow.conditions.length === 0
                ? 'always match'
                : 'configured'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-xs)] text-ink-muted">Actions</dt>
            <dd>{Array.isArray(workflow.actions) ? workflow.actions.length : 0}</dd>
          </div>
        </dl>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[var(--text-sm)] font-semibold">Dry run</h2>
          <div className="flex items-center gap-2">
            <label className="text-[var(--text-xs)] text-ink-secondary">
              Days
              <input
                type="number"
                min={1}
                max={30}
                value={dryRunDays}
                onChange={(e) => setDryRunDays(Number(e.target.value) || 7)}
                className="ml-2 h-8 w-16 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)]"
              />
            </label>
            <Button size="sm" variant="primary" onClick={() => dryRun.refetch()}>
              {dryRun.isFetching ? 'Running…' : 'Run dry run'}
            </Button>
          </div>
        </div>
        {dryRun.data ? (
          <div className="flex flex-col gap-2 text-[var(--text-sm)]" data-testid="dry-run-report">
            <p>
              Evaluated <span className="tnum font-medium">{dryRun.data.evaluated}</span> events
              over the last {dryRun.data.windowDays} days — matched{' '}
              <span className="tnum font-medium">{dryRun.data.matched}</span>.
            </p>
            {dryRun.data.samples.length ? (
              <ul className="flex flex-col gap-1 text-[var(--text-xs)]">
                {dryRun.data.samples.map((s, i) => (
                  <li key={i} className="border-b border-hairline pb-1 last:border-0">
                    <LocalDateTime iso={s.occurredAt} /> — {s.summary}
                    {s.wouldRunActions.length ? (
                      <span className="text-ink-muted"> → {s.wouldRunActions.join(', ')}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-[var(--text-xs)] text-ink-muted">
            No dry run yet — nothing is executed; this only reports what would have happened.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[var(--text-sm)] font-semibold">Run history</h2>
        {(runs.data ?? []).length === 0 ? (
          <p className="text-[var(--text-xs)] text-ink-muted">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[var(--text-xs)]" data-testid="workflow-runs">
            {(runs.data ?? []).map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 border-b border-hairline pb-1.5 last:border-0"
              >
                <span className="flex items-center gap-2">
                  <StatusPill tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>
                  <LocalDateTime iso={new Date(r.startedAt).toISOString()} />
                </span>
                {r.error ? <span className="text-critical">{r.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[var(--text-sm)] font-semibold">Versions</h2>
        <ul className="flex flex-col gap-1.5 text-[var(--text-xs)]">
          {(versions.data ?? []).map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 border-b border-hairline pb-1.5 last:border-0"
            >
              <span>
                v{v.version} — <LocalDateTime iso={new Date(v.createdAt).toISOString()} />
                {v.version === workflow.version ? ' (current)' : ''}
              </span>
              {canManage && v.version !== workflow.version ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => rollback.mutate({ id: workflow.id, toVersion: v.version })}
                  disabled={rollback.isPending}
                >
                  Roll back
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
