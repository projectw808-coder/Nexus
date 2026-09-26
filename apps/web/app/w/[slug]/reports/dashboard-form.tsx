'use client';

/** Create or rename a dashboard, set the default, or delete it. */
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { CONTROL_CLASS, Field } from '@/components/field';
import { useTRPC } from '@/lib/trpc-client';

export function DashboardForm({
  slug,
  dashboard,
}: {
  slug: string;
  dashboard?: {
    id: string;
    name: string;
    description: string | null;
    isShared: boolean;
    isDefault: boolean;
  };
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [name, setName] = useState(dashboard?.name ?? '');
  const [description, setDescription] = useState(dashboard?.description ?? '');
  const [isShared, setIsShared] = useState(dashboard?.isShared ?? true);
  const [isDefault, setIsDefault] = useState(dashboard?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);

  const onError = (e: { message: string }) => setError(e.message);
  const create = useMutation(
    trpc.dashboard.create.mutationOptions({
      onSuccess: (row) => {
        router.push(`/w/${slug}/reports/${row.id}`);
        router.refresh();
      },
      onError,
    }),
  );
  const update = useMutation(
    trpc.dashboard.update.mutationOptions({
      onSuccess: (row) => {
        router.push(`/w/${slug}/reports/${row.id}`);
        router.refresh();
      },
      onError,
    }),
  );
  const remove = useMutation(
    trpc.dashboard.delete.mutationOptions({
      onSuccess: () => {
        router.push(`/w/${slug}/reports`);
        router.refresh();
      },
      onError,
    }),
  );
  const busy = create.isPending || update.isPending || remove.isPending;

  return (
    <Card className="flex max-w-xl flex-col gap-4 p-4">
      <Field id="dashboard-name" label="Name">
        <input
          id="dashboard-name"
          className={CONTROL_CLASS}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Weekly pulse"
        />
      </Field>
      <Field id="dashboard-description" label="Description" hint="Optional.">
        <input
          id="dashboard-description"
          className={CONTROL_CLASS}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-[var(--text-sm)]">
        <input type="checkbox" checked={isShared} onChange={(e) => setIsShared(e.target.checked)} />
        Shared with the workspace
      </label>
      <label className="flex items-center gap-2 text-[var(--text-sm)]">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Open this one when someone clicks Reports
      </label>

      {error ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={busy || name.trim().length === 0}
          onClick={() => {
            setError(null);
            if (dashboard) {
              update.mutate({
                id: dashboard.id,
                name,
                description: description || null,
                isShared,
                isDefault,
              });
            } else {
              create.mutate({ name, description: description || null, isShared });
            }
          }}
        >
          {busy ? 'Saving…' : dashboard ? 'Save' : 'Create dashboard'}
        </Button>
        <Button onClick={() => router.back()}>Cancel</Button>
        {dashboard ? (
          <Button
            variant="danger"
            className="ml-auto"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete "${dashboard.name}" and all of its widgets?`)) return;
              setError(null);
              remove.mutate({ id: dashboard.id });
            }}
          >
            Delete dashboard
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
