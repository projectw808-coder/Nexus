import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WidgetKind } from '@nexus/core';
import { LinkButton } from '@/components/button';
import { WidgetChart } from '@/components/charts';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode, messageOf, remediationOf } from '@/lib/errors';
import { canManageDashboards } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { WidgetActions } from '../widget-actions';

/** Tiles that read as a single number get one column; everything else gets two. */
const SPAN: Record<WidgetKind, string> = {
  STAT_TILE: 'lg:col-span-1',
  LINE: 'lg:col-span-2',
  BAR: 'lg:col-span-2',
  STACKED_BAR: 'lg:col-span-2',
  FUNNEL: 'lg:col-span-2',
  COHORT_HEATMAP: 'lg:col-span-3',
  TABLE: 'lg:col-span-3',
};

/**
 * One dashboard. Each widget's query is executed server-side and the result handed to the
 * matching chart, which is where every §12.4 rule lives. A widget whose query has gone stale
 * (its object type renamed, its list deleted) renders its own error card — one broken tile never
 * takes the dashboard down with it.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ slug: string; dashboardId: string }>;
}) {
  const { slug, dashboardId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const manages = canManageDashboards(workspace.role);

  let dashboard;
  try {
    dashboard = await client.dashboard.get({ id: dashboardId });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
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

  const tiles = await Promise.all(
    dashboard.widgets.map(async (w) => {
      try {
        const data = await client.widget.data({ widgetId: w.id });
        return { widget: w, result: data.result, error: null };
      } catch (e) {
        return {
          widget: w,
          result: null,
          error: { message: messageOf(e), remediation: remediationOf(e) },
        };
      }
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={dashboard.name}
        eyebrow={
          <Link href={`/w/${workspace.slug}/reports`} className="text-link hover:underline">
            Reports
          </Link>
        }
        description={dashboard.description ?? undefined}
        actions={
          manages ? (
            <>
              <LinkButton
                href={`/w/${workspace.slug}/reports/${dashboard.id}/widgets/new`}
                variant="primary"
              >
                Add widget
              </LinkButton>
              <LinkButton href={`/w/${workspace.slug}/reports/${dashboard.id}/settings`}>
                Settings
              </LinkButton>
            </>
          ) : null
        }
      />

      {tiles.length === 0 ? (
        <EmptyState
          title="This dashboard is empty"
          description={
            manages
              ? 'Add a stat tile for messages today, a stacked bar for the channel mix, or a line for sentiment over time.'
              : 'Managers, admins and owners add widgets. Once there is one, it appears here.'
          }
          action={
            manages ? (
              <LinkButton
                href={`/w/${workspace.slug}/reports/${dashboard.id}/widgets/new`}
                variant="primary"
              >
                Add widget
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3" data-testid="dashboard-grid">
          {tiles.map(({ widget, result, error }) => (
            <div key={widget.id} className={`flex flex-col gap-1.5 ${SPAN[widget.kind]}`}>
              {error || !result ? (
                <section
                  role="alert"
                  data-chart-card
                  className="rounded-[var(--radius-card)] border border-hairline bg-card p-4"
                  style={{ borderColor: 'var(--status-critical)' }}
                >
                  <h3 className="text-[var(--text-sm)] font-semibold tracking-tight">
                    {widget.title}
                  </h3>
                  <p className="mt-1 text-[var(--text-xs)] text-ink-secondary">{error?.message}</p>
                  {error?.remediation ? (
                    <p className="mt-1 text-[var(--text-xs)] text-ink-muted">{error.remediation}</p>
                  ) : null}
                </section>
              ) : (
                <WidgetChart kind={widget.kind} title={widget.title} result={result} />
              )}
              {manages ? (
                <WidgetActions
                  slug={workspace.slug}
                  dashboardId={dashboard.id}
                  widgetId={widget.id}
                  title={widget.title}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
