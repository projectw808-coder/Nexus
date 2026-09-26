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

type Event = RouterOutputs['webhookEvent']['list'][number];

export function WebhooksView({
  connectionId,
  initial,
}: {
  connectionId: string;
  initial: Event[];
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: events } = useQuery({
    ...trpc.webhookEvent.list.queryOptions({ connectionId }),
    initialData: initial,
  });
  const replay = useMutation(
    trpc.webhookEvent.replay.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.webhookEvent.list.pathKey() }),
    }),
  );

  if (events.length === 0) {
    return (
      <EmptyState
        compact
        title="No deliveries yet"
        description="Verified and rejected webhook payloads for this connection show up here as they arrive."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {replay.error ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {replay.error.message}
        </p>
      ) : null}
      <Card className="divide-y divide-[var(--border-hairline)]">
        {events.map((e) => (
          <div key={e.id} className="flex flex-col gap-1 px-4 py-3 text-[var(--text-sm)]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusPill tone={e.verified ? 'good' : 'critical'} glyph={null}>
                  {e.verified ? 'verified' : 'rejected'}
                </StatusPill>
                <LocalDateTime iso={isoOf(e.receivedAt) ?? ''} />
                {e.processedAt ? (
                  <span className="text-[var(--text-xs)] text-ink-muted">processed</span>
                ) : e.verified ? (
                  <span className="text-[var(--text-xs)] text-warning">pending</span>
                ) : null}
              </div>
              {e.verified ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={replay.isPending}
                  onClick={() => replay.mutate({ id: e.id })}
                >
                  Replay
                </Button>
              ) : null}
            </div>
            {e.remediation ? (
              <p className="text-[var(--text-xs)] text-critical">{e.remediation}</p>
            ) : null}
            {e.lastError ? (
              <p className="text-[var(--text-xs)] text-ink-muted">Last error: {e.lastError}</p>
            ) : null}
          </div>
        ))}
      </Card>
    </div>
  );
}
