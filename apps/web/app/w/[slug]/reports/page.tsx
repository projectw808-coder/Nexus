import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LinkButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

/**
 * Reports (§12.2.E): the dashboard switcher. One dashboard is the default and the screen opens
 * straight on it, so the common case is "I clicked Reports and I am looking at my numbers"
 * rather than "I am looking at a list of lists".
 */
export default async function ReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const manages = canManageDashboards(workspace.role);

  let dashboards;
  try {
    dashboards = await client.dashboard.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Reports are closed to your role"
          description="Reading dashboards needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  const landing = dashboards.find((d) => d.isDefault) ?? dashboards[0];
  if (landing && dashboards.length === 1) {
    redirect(`/w/${workspace.slug}/reports/${landing.id}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Dashboards built from a fixed widget catalogue, each bound to a saved query."
        actions={
          manages ? (
            <LinkButton href={`/w/${workspace.slug}/reports/new`} variant="primary">
              New dashboard
            </LinkButton>
          ) : null
        }
      />

      {dashboards.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description={
            manages
              ? 'Create one, then add widgets: messages today, channel mix, sentiment over time, a pipeline funnel.'
              : 'Managers, admins and owners build dashboards. Once there is one, it appears here.'
          }
          action={
            manages ? (
              <LinkButton href={`/w/${workspace.slug}/reports/new`} variant="primary">
                New dashboard
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Card className="h-full p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/w/${workspace.slug}/reports/${d.id}`}
                    className="text-[var(--text-sm)] font-medium text-link underline-offset-2 hover:underline"
                  >
                    {d.name}
                  </Link>
                  {d.isDefault ? <StatusPill tone="neutral">Default</StatusPill> : null}
                </div>
                {d.description ? (
                  <p className="mt-1 text-[var(--text-xs)] text-ink-secondary">{d.description}</p>
                ) : null}
                <p className="mt-3 text-[var(--text-xs)] text-ink-muted">
                  {d._count.widgets} {d._count.widgets === 1 ? 'widget' : 'widgets'} ·{' '}
                  {d.isShared ? 'Shared with the workspace' : 'Private'}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
