import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { DashboardForm } from '../../dashboard-form';

export default async function DashboardSettingsPage({
  params,
}: {
  params: Promise<{ slug: string; dashboardId: string }>;
}) {
  const { slug, dashboardId } = await params;
  const workspace = await getWorkspace(slug);
  if (!canManageDashboards(workspace.role)) {
    return (
      <PermissionDenied
        title="Dashboard settings need a manager"
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }
  const client = await api(workspace.slug);
  let dashboard;
  try {
    dashboard = await client.dashboard.get({ id: dashboardId });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard settings" eyebrow={dashboard.name} />
      <DashboardForm
        slug={workspace.slug}
        dashboard={{
          id: dashboard.id,
          name: dashboard.name,
          description: dashboard.description,
          isShared: dashboard.isShared,
          isDefault: dashboard.isDefault,
        }}
      />
    </div>
  );
}
