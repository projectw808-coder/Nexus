import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { ConnectionCard } from './connection-card';
import { ConnectPlatformCard } from './connect-platform-card';
import { KeitaroConnectForm } from './keitaro-connect-form';

export const dynamic = 'force-dynamic';

/** OAuth-redirect platforms; `connectUrl` degrades to "not configured" for any not yet registered. */
const CONNECTABLE = ['FACEBOOK', 'X', 'LINKEDIN', 'TIKTOK', 'YOUTUBE', 'MOCK'] as const;

/**
 * The integrations hub's connection grid (§12.2.C): status, token expiry, a rate-budget meter
 * and a 7-day sparkline per card, plus the connect gallery. Keitaro (`authKind: 'api_key'`,
 * §8.6) has no redirect, so it gets its own form instead of a link. Per-connection detail
 * (Overview/Data/Field mapping/Permissions/Webhooks/Activity/Danger zone) lives one level down.
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
  const [connectUrls, cards] = await Promise.all([
    manages
      ? Promise.all(
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
      : Promise.resolve([]),
    Promise.all(
      connections.map(async (c) => {
        const [detail, dailyActivity] = await Promise.all([
          client.connection.get({ id: c.id }),
          client.connection.dailyActivity({ id: c.id }),
        ]);
        return { connection: c, budget: detail.budget, dailyActivity };
      }),
    ),
  ]);

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

      <div className="flex items-center justify-between">
        <h2 className="text-[var(--text-md)] font-semibold tracking-tight">
          Connected accounts{' '}
          <span className="tnum font-normal text-ink-muted">({connections.length})</span>
        </h2>
        <Link
          href={`/w/${workspace.slug}/settings/health`}
          className="text-[var(--text-sm)] text-link underline-offset-2 hover:underline"
        >
          Health console
        </Link>
      </div>

      <section aria-labelledby="connections-heading" className="flex flex-col gap-3">
        <h2 id="connections-heading" className="sr-only">
          Connected accounts
        </h2>
        {connections.length === 0 ? (
          <EmptyState
            compact
            title="Nothing connected yet"
            description="Connect a platform below; its DMs, comments and mentions start landing in the inbox within seconds."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map(({ connection, budget, dailyActivity }) => (
              <ConnectionCard
                key={connection.id}
                workspaceSlug={workspace.slug}
                connection={connection}
                budget={budget}
                dailyActivity={dailyActivity}
                canConfigure={manages}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="connect-heading" className="flex flex-col gap-3">
        <h2 id="connect-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Add a connection
        </h2>
        {manages ? (
          <div className="flex flex-col gap-4">
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {connectUrls.map((c) => (
                <ConnectPlatformCard key={c.platform} platform={c.platform} url={c.url} />
              ))}
            </ul>
            <KeitaroConnectForm />
          </div>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-muted">
            Owners and admins connect platforms.
          </p>
        )}
      </section>
    </div>
  );
}
