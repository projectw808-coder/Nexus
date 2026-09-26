'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Connection = RouterOutputs['connection']['get'];

export function DataResourcesView({
  connectionId,
  initial,
}: {
  connectionId: string;
  initial: Connection;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: connection } = useQuery({
    ...trpc.connection.get.queryOptions({ id: connectionId }),
    initialData: initial,
  });
  const [backfillDays, setBackfillDays] = useState(connection.settings.backfillDays);

  const update = useMutation(
    trpc.connection.updateSettings.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.connection.get.pathKey() }),
    }),
  );

  const resources = connection.manifest?.resources ?? [];
  const resourceSettings = connection.settings.resources;

  const toggle = (resourceId: string, enabled: boolean) => {
    update.mutate({
      id: connectionId,
      settings: {
        resources: {
          ...resourceSettings,
          [resourceId]: { ...(resourceSettings[resourceId] ?? { enabled: true }), enabled },
        },
      },
    });
  };

  const setInterval_ = (resourceId: string, intervalSeconds: number) => {
    update.mutate({
      id: connectionId,
      settings: {
        resources: {
          ...resourceSettings,
          [resourceId]: {
            ...(resourceSettings[resourceId] ?? { enabled: true }),
            intervalSeconds,
          },
        },
      },
    });
  };

  if (!connection.manifest) {
    return <p className="text-[var(--text-sm)] text-ink-muted">No connector registered.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <table className="w-full text-[var(--text-sm)]">
          <thead>
            <tr className="border-b border-hairline text-left text-[var(--text-xs)] text-ink-muted">
              <th className="px-3 py-2 font-medium">Resource</th>
              <th className="px-3 py-2 font-medium">Enabled</th>
              <th className="px-3 py-2 font-medium">Interval (s)</th>
              <th className="px-3 py-2 font-medium">Backfill</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => {
              const setting = resourceSettings[r.id];
              const enabled = setting?.enabled ?? r.defaultEnabled;
              return (
                <tr key={r.id} className="border-b border-hairline last:border-0">
                  <td className="px-3 py-2">
                    <p className="font-medium">{r.displayName}</p>
                    {r.warning ? (
                      <p className="text-[var(--text-xs)] text-warning">{r.warning}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => toggle(r.id, e.target.checked)}
                        disabled={update.isPending}
                      />
                      <span className="sr-only">Sync {r.displayName}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      aria-label={`Poll interval in seconds for ${r.displayName}`}
                      defaultValue={setting?.intervalSeconds ?? r.defaultIntervalSeconds}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v > 0) setInterval_(r.id, v);
                      }}
                      className="w-24 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1 tnum"
                    />
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{r.supportsBackfill ? 'yes' : 'no'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card className="flex flex-wrap items-center gap-3 p-4">
        <label className="flex items-center gap-2 text-[var(--text-sm)]">
          Backfill window (days)
          <input
            type="number"
            min={1}
            value={backfillDays}
            onChange={(e) => setBackfillDays(Number(e.target.value))}
            className="w-24 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1 tnum"
          />
        </label>
        <Button
          size="sm"
          disabled={update.isPending || backfillDays === connection.settings.backfillDays}
          onClick={() => update.mutate({ id: connectionId, settings: { backfillDays } })}
        >
          Save
        </Button>
        {update.error ? (
          <span role="alert" className="text-[var(--text-sm)] text-critical">
            {update.error.message}
          </span>
        ) : null}
      </Card>
    </div>
  );
}
