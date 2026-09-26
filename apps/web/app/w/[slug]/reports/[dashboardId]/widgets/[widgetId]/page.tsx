import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { WidgetForm } from '../../../widget-form';
import { formOptions } from '../../../form-options';

export default async function EditWidgetPage({
  params,
}: {
  params: Promise<{ slug: string; dashboardId: string; widgetId: string }>;
}) {
  const { slug, dashboardId, widgetId } = await params;
  const workspace = await getWorkspace(slug);
  if (!canManageDashboards(workspace.role)) {
    return (
      <PermissionDenied
        title="Editing widgets needs a manager"
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
  const widget = dashboard.widgets.find((w) => w.id === widgetId);
  if (!widget) notFound();
  const { objects, lists } = await formOptions(client);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`Edit "${widget.title}"`} eyebrow={dashboard.name} />
      <WidgetForm
        slug={workspace.slug}
        dashboardId={dashboardId}
        objects={objects}
        lists={lists}
        widget={{
          id: widget.id,
          kind: widget.kind,
          title: widget.title,
          query: widget.query,
        }}
      />
    </div>
  );
}
