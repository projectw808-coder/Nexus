import { Card } from '@/components/card';
import { LocalDateTime } from '@/components/local-time';
import { Meter } from '@/components/meter';
import { api } from '@/lib/api';
import { isoOf } from '@/lib/format';
import { getWorkspace } from '@/lib/workspace';

export default async function ConnectionOverviewPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const connection = await client.connection.get({ id: connectionId });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Account</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[var(--text-sm)]">
          <dt className="text-ink-muted">Account</dt>
          <dd>{connection.accountName}</dd>
          <dt className="text-ink-muted">API version</dt>
          <dd className="tnum">{connection.apiVersion}</dd>
          <dt className="text-ink-muted">Owner</dt>
          <dd>{connection.ownerUserId ?? '—'}</dd>
          <dt className="text-ink-muted">Token expires</dt>
          <dd>
            {connection.tokenExpiresAt ? (
              <LocalDateTime iso={isoOf(connection.tokenExpiresAt) ?? ''} />
            ) : (
              'never'
            )}
          </dd>
          <dt className="text-ink-muted">Last sync</dt>
          <dd>
            {connection.lastSyncAt ? (
              <LocalDateTime iso={isoOf(connection.lastSyncAt) ?? ''} />
            ) : (
              'not synced yet'
            )}
          </dd>
          <dt className="text-ink-muted">Health score</dt>
          <dd className="tnum">{connection.healthScore}/100</dd>
        </dl>
        {connection.pausedReason ? (
          <p className="rounded-[var(--radius-control)] border border-hairline bg-raised p-2 text-[var(--text-xs)] text-ink-secondary">
            {connection.pausedReason}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Budget</h2>
        {connection.budget ? (
          <div className="flex flex-col gap-3">
            {connection.budget.windows.map((w) => (
              <Meter
                key={w.id}
                used={w.used}
                limit={w.limit}
                label={`${w.limit.toLocaleString()} ${w.endpoint ?? w.id}`}
              />
            ))}
          </div>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-muted">No connector registered.</p>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 lg:col-span-2">
        <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Capabilities</h2>
        {connection.manifest ? (
          <ul className="flex flex-wrap gap-1.5">
            {connection.manifest.capabilities.map((cap) => (
              <li
                key={cap}
                className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[var(--text-xs)] ${
                  connection.degradedCapabilities.includes(cap)
                    ? 'border-critical text-critical'
                    : 'border-hairline text-ink-secondary'
                }`}
              >
                {cap}
                {connection.degradedCapabilities.includes(cap) ? ' (degraded)' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-muted">No connector registered.</p>
        )}
      </Card>

      {connection.errors.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4 lg:col-span-2">
          <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Recent errors</h2>
          <ul className="flex flex-col gap-2">
            {connection.errors.map((e) => (
              <li key={e.id} className="text-[var(--text-sm)]">
                <span className="font-medium text-critical">{e.code}</span>{' '}
                <span className="text-ink-secondary">{e.message}</span>
                {e.remediation ? (
                  <p className="text-[var(--text-xs)] text-ink-muted">{e.remediation}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
