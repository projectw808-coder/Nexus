import Link from 'next/link';
import { Card } from '@/components/card';
import { LocalDateTime } from '@/components/local-time';
import { Meter } from '@/components/meter';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { isoOf } from '@/lib/format';
import { platformName } from '@/lib/platforms';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * The workspace health console (§12.2.C): quota consumption per connection, webhook delivery
 * health, failed runs, tokens expiring soon, and drift — with one reassuring state when none of
 * that needs attention. Read-only; every fix (reconnect, replay, pause) lives on its own screen.
 */
export default async function HealthConsolePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let health;
  try {
    health = await client.health.summary({});
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="The health console is hidden from your role"
          description="Reading workspace health needs a role that can see connections."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  return (
    <div className="flex flex-col gap-6">
      {health.everythingFine ? (
        <Card className="flex items-center gap-2 border-good p-4">
          <StatusPill tone="good">Everything is fine</StatusPill>
          <span className="text-[var(--text-sm)] text-ink-secondary">
            All {health.connectionCount} connection{health.connectionCount === 1 ? '' : 's'} are
            connected, no runs failed in the last 24 hours, and every webhook verified.
          </span>
        </Card>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">
          Tokens expiring within 30 days
        </h2>
        {health.expiringTokens.length === 0 ? (
          <p className="text-[var(--text-sm)] text-ink-muted">None.</p>
        ) : (
          <Card className="divide-y divide-[var(--border-hairline)]">
            {health.expiringTokens.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 px-4 py-2.5 text-[var(--text-sm)]"
              >
                <Link
                  href={`/w/${workspace.slug}/settings/integrations/${c.id}/overview`}
                  className="text-link underline-offset-2 hover:underline"
                >
                  {c.label}
                </Link>
                <span className="text-ink-muted">
                  {c.tokenExpiresAt ? (
                    <LocalDateTime iso={isoOf(c.tokenExpiresAt) ?? ''} />
                  ) : (
                    'unknown'
                  )}
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">Failed runs (24h)</h2>
        {health.failedRuns.length === 0 ? (
          <p className="text-[var(--text-sm)] text-ink-muted">None.</p>
        ) : (
          <Card className="divide-y divide-[var(--border-hairline)]">
            {health.failedRuns.map((r) => (
              <div key={r.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-[var(--text-sm)]">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/w/${workspace.slug}/settings/integrations/${r.connectionId}/activity`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {r.connection.label} — {r.resource}
                  </Link>
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    <LocalDateTime iso={isoOf(r.startedAt) ?? ''} />
                  </span>
                </div>
                {r.remediation ? (
                  <p className="text-[var(--text-xs)] text-ink-muted">{r.remediation}</p>
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">
          Webhook delivery (24h)
        </h2>
        <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
          <Stat label="Delivered" value={health.webhooks.total} />
          <Stat
            label="Rejected"
            value={health.webhooks.rejected}
            tone={health.webhooks.rejected > 0 ? 'critical' : undefined}
          />
          <Stat label="Awaiting processing" value={health.webhooks.unprocessed} />
          <Stat
            label="Avg / max lag"
            value={
              health.webhooks.avgLagMs === null
                ? '—'
                : `${Math.round(health.webhooks.avgLagMs / 1000)}s / ${Math.round((health.webhooks.maxLagMs ?? 0) / 1000)}s`
            }
          />
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">Quota consumption</h2>
        {health.budgets.length === 0 ? (
          <p className="text-[var(--text-sm)] text-ink-muted">No connections yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {health.budgets.map((b) => (
              <Card key={b.connectionId} className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/w/${workspace.slug}/settings/integrations/${b.connectionId}/overview`}
                    className="text-[var(--text-sm)] font-medium text-link underline-offset-2 hover:underline"
                  >
                    {b.label}
                  </Link>
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    {platformName(b.platform)}
                  </span>
                </div>
                {b.snapshot.windows.map((w) => (
                  <Meter
                    key={w.id}
                    used={w.used}
                    limit={w.limit}
                    label={`${w.limit.toLocaleString()} ${w.endpoint ?? w.id}`}
                  />
                ))}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">
          Drift (reconciliation)
        </h2>
        {health.driftSamples.length === 0 ? (
          <p className="text-[var(--text-sm)] text-ink-muted">
            Not measured yet — nightly reconciliation sampling is not built in this phase.
          </p>
        ) : (
          <Card className="divide-y divide-[var(--border-hairline)]">
            {health.driftSamples.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between gap-2 px-4 py-2.5 text-[var(--text-sm)]"
              >
                <span>
                  {d.connection.label} — {d.resource}
                </span>
                <span className="tnum text-ink-muted">
                  {d.driftCount}/{d.sampleSize} drifted
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'critical';
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`text-[var(--text-lg)] font-semibold tnum ${tone === 'critical' ? 'text-critical' : 'text-ink'}`}
      >
        {value}
      </span>
      <span className="text-[var(--text-xs)] text-ink-muted">{label}</span>
    </div>
  );
}
