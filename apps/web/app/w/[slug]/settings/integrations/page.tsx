import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { isoOf } from '@/lib/format';
import { platformName } from '@/lib/platforms';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

const CONNECTABLE = ['FACEBOOK', 'MOCK'] as const;

/**
 * Connections (Phase 7 minimum for the §15 e2e path; the full integrations hub with the
 * connection grid, health console and quota simulator is Phase 9): what is connected, its
 * status and last sync, and a way to connect a platform the app has credentials for.
 */
export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ connectError?: string; connected?: string }>;
}) {
  const { slug } = await params;
  const { connectError, connected } = await searchParams;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let connections;
  try {
    connections = await client.connection.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Integrations are hidden from your role"
          description="Reading connections needs a role that can see them."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  const manages = canManage(workspace.role);
  const connectUrls = manages
    ? await Promise.all(
        CONNECTABLE.map(async (platform) => {
          try {
            const r = await client.connection.connectUrl({
              platform,
              returnTo: `/w/${workspace.slug}/settings/integrations`,
            });
            return { platform, url: r.url };
          } catch {
            return { platform, url: null };
          }
        }),
      )
    : [];

  return (
    <div className="flex flex-col gap-6">
      {connectError ? (
        <p
          role="alert"
          data-testid="connect-error"
          className="rounded-[var(--radius-card)] border border-hairline bg-card px-4 py-3 text-[var(--text-sm)] text-critical"
        >
          <span aria-hidden>! </span>Connecting failed: {connectError}
        </p>
      ) : connected ? (
        <p
          role="status"
          data-testid="connect-ok"
          className="rounded-[var(--radius-card)] border border-hairline bg-card px-4 py-3 text-[var(--text-sm)] text-good"
        >
          <span aria-hidden>✓ </span>Connected {connected} account{connected === '1' ? '' : 's'}.
          The first backfill is running; threads appear in the inbox as they land.
        </p>
      ) : null}
      <section aria-labelledby="connections-heading" className="flex flex-col gap-3">
        <h2 id="connections-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Connected accounts{' '}
          <span className="tnum font-normal text-ink-muted">({connections.length})</span>
        </h2>
        {connections.length === 0 ? (
          <EmptyState
            compact
            title="Nothing connected yet"
            description="Connect a platform below; its DMs, comments and mentions start landing in the inbox within seconds."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {connections.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[var(--text-sm)]"
                data-testid="connection-row"
              >
                <span className="font-medium">{c.label}</span>
                <span className="text-ink-muted">{platformName(c.platform)}</span>
                <StatusPill
                  tone={
                    c.status === 'CONNECTED'
                      ? 'good'
                      : c.status === 'DEGRADED' || c.status === 'PAUSED'
                        ? 'warning'
                        : 'critical'
                  }
                >
                  {c.status.toLowerCase().replace('_', ' ')}
                </StatusPill>
                <span className="text-[var(--text-xs)] text-ink-muted">
                  {c.lastSyncAt ? (
                    <>
                      last sync <LocalDateTime iso={isoOf(c.lastSyncAt) ?? ''} />
                    </>
                  ) : (
                    'not synced yet'
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="connect-heading" className="flex flex-col gap-3">
        <h2 id="connect-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Add a connection
        </h2>
        {manages ? (
          <ul className="flex flex-wrap gap-2">
            {connectUrls.map((c) => (
              <li key={c.platform}>
                {c.url ? (
                  <LinkButton href={c.url} variant="secondary" size="md" prefetch={false}>
                    Connect {platformName(c.platform)}
                  </LinkButton>
                ) : (
                  <span className="text-[var(--text-sm)] text-ink-muted">
                    {platformName(c.platform)}: not configured on this server
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-muted">
            Owners and admins connect platforms. The full integrations hub (health console, quota
            simulator, field mapping) arrives in Phase 9.
          </p>
        )}
      </section>
    </div>
  );
}
