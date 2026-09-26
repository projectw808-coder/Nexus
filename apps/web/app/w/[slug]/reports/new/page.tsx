import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { DashboardForm } from '../dashboard-form';

export default async function NewDashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  if (!canManageDashboards(workspace.role)) {
    return (
      <PermissionDenied
        title="Creating dashboards needs a manager"
        description="Dashboards are shared with the whole workspace, so managers, admins and owners build them."
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New dashboard" eyebrow="Reports" />
      <DashboardForm slug={workspace.slug} />
    </div>
  );
}
