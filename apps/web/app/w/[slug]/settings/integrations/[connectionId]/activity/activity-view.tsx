'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { StatusPill } from '@/components/status-pill';
import { isoOf } from '@/lib/format';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Runs = RouterOutputs['connection']['runs'];
type DeadLetters = RouterOutputs['connection']['deadLetters'];

const RUN_TONE = {
  QUEUED: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'good',
  FAILED: 'critical',
  CANCELLED: 'neutral',
} as const;

export function ActivityView({
  connectionId,
  initialRuns,
  initialDeadLetters,
}: {
  connectionId: string;
  initialRuns: Runs;
  initialDeadLetters: DeadLetters;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: runs } = useQuery({
    ...trpc.connection.runs.queryOptions({ id: connectionId }),
    initialData: initialRuns,
  });
  const { data: deadLetters } = useQuery({
    ...trpc.connection.deadLetters.queryOptions({ connectionId }),
    initialData: initialDeadLetters,
  });
  const replay = useMutation(
    trpc.connection.replayDeadLetter.mutationOptions({
      onSuccess: () =>
        void qc.invalidateQueries({ queryKey: trpc.connection.deadLetters.pathKey() }),
    }),
  );

  const pendingDeadLetters = deadLetters.filter((d) => !d.replayedAt);

  return (
    <div className="flex flex-col gap-4">
      {pendingDeadLetters.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-[var(--text-sm)] font-semibold tracking-tight text-critical">
            Needs attention ({pendingDeadLetters.length})
          </h2>
          {pendingDeadLetters.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-2 text-[var(--text-sm)]"
            >
              <span>
                {d.jobName} — {d.errorMessage}{' '}
                <span className="text-[var(--text-xs)] text-ink-muted">
                  ({d.attempts} attempts)
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={replay.isPending}
                onClick={() => replay.mutate({ id: d.id })}
              >
                Replay
              </Button>
            </div>
          ))}
        </Card>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          compact
          title="No runs yet"
          description="Backfills and delta polls appear here as they run."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-[var(--text-sm)]">
            <thead>
              <tr className="border-b border-hairline text-left text-[var(--text-xs)] text-ink-muted">
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Fetched</th>
                <th className="px-3 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-hairline last:border-0 align-top">
                  <td className="px-3 py-2">{r.resource}</td>
                  <td className="px-3 py-2 text-ink-muted">{r.trigger.toLowerCase()}</td>
                  <td className="px-3 py-2">
                    <StatusPill tone={RUN_TONE[r.status]} glyph={null}>
                      {r.status.toLowerCase()}
                    </StatusPill>
                  </td>
                  <td className="px-3 py-2 tnum">
                    <LocalDateTime iso={isoOf(r.startedAt) ?? ''} />
                  </td>
                  <td className="px-3 py-2 tnum">{r.itemsFetched}</td>
                  <td className="px-3 py-2">
                    {r.errorCode ? (
                      <div>
                        <p className="font-medium text-critical">{r.errorCode}</p>
                        {r.remediation ? (
                          <p className="text-[var(--text-xs)] text-ink-muted">{r.remediation}</p>
                        ) : null}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
