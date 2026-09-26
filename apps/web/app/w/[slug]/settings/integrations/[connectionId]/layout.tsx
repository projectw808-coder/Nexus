import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { platformName } from '@/lib/platforms';
import { getWorkspace } from '@/lib/workspace';

const STATUS_TONE = {
  CONNECTED: 'good',
  DEGRADED: 'warning',
  PAUSED: 'warning',
  RECONNECT_REQUIRED: 'critical',
  REVOKED: 'critical',
} as const;

export default async function ConnectionDetailLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
  children: React.ReactNode;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let connection;
  try {
    connection = await client.connection.get({ id: connectionId });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }

  const base = `/w/${workspace.slug}/settings/integrations/${connectionId}`;
  const tabs = [
    { label: 'Overview', href: `${base}/overview` },
    { label: 'Data & resources', href: `${base}/data` },
    { label: 'Field mapping', href: `${base}/mapping` },
    { label: 'Permissions', href: `${base}/permissions` },
    { label: 'Webhooks', href: `${base}/webhooks` },
    { label: 'Activity', href: `${base}/activity` },
    { label: 'Danger zone', href: `${base}/danger` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/w/${workspace.slug}/settings/integrations`}
        className="text-[var(--text-sm)] text-link underline-offset-2 hover:underline"
      >
        ← Integrations
      </Link>
      <PageHeader
        title={connection.label}
        actions={
          <StatusPill tone={STATUS_TONE[connection.status]}>
            {connection.status.toLowerCase().replace('_', ' ')}
          </StatusPill>
        }
        description={platformName(connection.platform)}
      />
      <SettingsTabs tabs={tabs} />
      {children}
    </div>
  );
}
