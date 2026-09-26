import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { canReadAudit } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const base = `/w/${workspace.slug}/settings`;
  const tabs = [
    { label: 'General', href: `${base}/general` },
    { label: 'Members', href: `${base}/members` },
    { label: 'Objects', href: `${base}/objects` },
    { label: 'Integrations', href: `${base}/integrations` },
    { label: 'Health', href: `${base}/health` },
    { label: 'Canned replies', href: `${base}/canned-replies` },
    { label: 'AI', href: `${base}/ai` },
    // Members and viewers cannot read the log; the tab still shows so the closed door is visible.
    {
      label: canReadAudit(workspace.role) ? 'Audit log' : 'Audit log (restricted)',
      href: `${base}/audit`,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description={workspace.name} />
      <SettingsTabs tabs={tabs} />
      <div>{children}</div>
    </div>
  );
}
