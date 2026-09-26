import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { WidgetForm } from '../../../widget-form';
import { formOptions } from '../../../form-options';

export default async function NewWidgetPage({
  params,
}: {
  params: Promise<{ slug: string; dashboardId: string }>;
}) {
  const { slug, dashboardId } = await params;
  const workspace = await getWorkspace(slug);
  if (!canManageDashboards(workspace.role)) {
    return (
      <PermissionDenied
        title="Adding widgets needs a manager"
        description="Dashboards are shared with the whole workspace, so managers, admins and owners build them."
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }
  const client = await api(workspace.slug);
  try {
    await client.dashboard.get({ id: dashboardId });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }
  const { objects, lists } = await formOptions(client);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Add a widget"
        description="Pick a kind, point it at a data source, and watch the preview before you save."
      />
      <WidgetForm slug={workspace.slug} dashboardId={dashboardId} objects={objects} lists={lists} />
    </div>
  );
}
