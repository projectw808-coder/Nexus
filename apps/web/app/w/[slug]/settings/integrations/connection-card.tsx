'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/button';
import { LocalDateTime } from '@/components/local-time';
import { Meter } from '@/components/meter';
import { Sparkline } from '@/components/sparkline';
import { StatusPill } from '@/components/status-pill';
import { isoOf } from '@/lib/format';
import { platformName } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Connection = RouterOutputs['connection']['list'][number];
type Budget = RouterOutputs['connection']['get']['budget'];

const STATUS_TONE = {
  CONNECTED: 'good',
  DEGRADED: 'warning',
  PAUSED: 'warning',
  RECONNECT_REQUIRED: 'critical',
  REVOKED: 'critical',
} as const;

function expiryCountdown(
  iso: string | null | undefined,
): { text: string; tone: 'warning' | 'critical' } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return { text: 'Token expired', tone: 'critical' };
  if (days === 0) return { text: 'Token expires today', tone: 'critical' };
  if (days <= 7)
    return { text: `Token expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'critical' };
  if (days <= 30) return { text: `Token expires in ${days} days`, tone: 'warning' };
  return null;
}

export function ConnectionCard({
  workspaceSlug,
  connection,
  budget,
  dailyActivity,
  canConfigure,
}: {
  workspaceSlug: string;
  connection: Connection;
  budget: Budget;
  dailyActivity: { date: string; itemsFetched: number }[];
  canConfigure: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.connection.list.pathKey() });
  const pause = useMutation(trpc.connection.pause.mutationOptions({ onSuccess: invalidate }));
  const resume = useMutation(trpc.connection.resume.mutationOptions({ onSuccess: invalidate }));
  const expiry = expiryCountdown(isoOf(connection.tokenExpiresAt));
  const primaryWindow = budget?.windows[0] ?? null;
  const busy = pause.isPending || resume.isPending;

  return (
    <li
      data-testid="connection-row"
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={`/w/${workspaceSlug}/settings/integrations/${connection.id}/overview`}
            className="truncate text-[var(--text-sm)] font-medium text-ink hover:underline"
          >
            {connection.label}
          </Link>
          <span className="text-[var(--text-xs)] text-ink-muted">
            {platformName(connection.platform)}
          </span>
        </div>
        <StatusPill tone={STATUS_TONE[connection.status]}>
          {connection.status.toLowerCase().replace('_', ' ')}
        </StatusPill>
      </div>

      {expiry ? (
        <p
          className={`text-[var(--text-xs)] font-medium ${expiry.tone === 'critical' ? 'text-critical' : 'text-warning'}`}
        >
          {expiry.text}
        </p>
      ) : null}

      {primaryWindow ? (
        <Meter
          used={primaryWindow.used}
          limit={primaryWindow.limit}
          label={`${primaryWindow.limit.toLocaleString()} ${primaryWindow.id}`}
        />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkline values={dailyActivity.map((d) => d.itemsFetched)} />
          <span className="text-[var(--text-xs)] text-ink-muted">
            {dailyActivity.reduce((s, d) => s + d.itemsFetched, 0).toLocaleString()} / 7d
          </span>
        </div>
        <span className="text-[var(--text-xs)] text-ink-muted">
          {connection.lastSyncAt ? (
            <>
              synced <LocalDateTime iso={isoOf(connection.lastSyncAt) ?? ''} />
            </>
          ) : (
            'not synced yet'
          )}
        </span>
      </div>

      {canConfigure ? (
        <div className="flex items-center justify-between border-t border-hairline pt-3">
          <Link
            href={`/w/${workspaceSlug}/settings/integrations/${connection.id}/overview`}
            className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
          >
            Manage
          </Link>
          {connection.status === 'PAUSED' ? (
            <Button size="sm" disabled={busy} onClick={() => resume.mutate({ id: connection.id })}>
              {resume.isPending ? 'Resuming…' : 'Resume'}
            </Button>
          ) : connection.status === 'CONNECTED' || connection.status === 'DEGRADED' ? (
            <Button size="sm" disabled={busy} onClick={() => pause.mutate({ id: connection.id })}>
              {pause.isPending ? 'Pausing…' : 'Pause'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
