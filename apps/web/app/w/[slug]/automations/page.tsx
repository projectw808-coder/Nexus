import Link from 'next/link';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { LinkButton } from '@/components/button';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { isoOf } from '@/lib/format';
import { canManageWorkflows } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

/** The Automations screen (§12.2.G): trigger → conditions → actions, dry-run, run history. */
export default async function AutomationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const manages = canManageWorkflows(workspace.role);

  let workflows;
  try {
    workflows = await client.workflow.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Automations are closed to your role"
          description="Reading workflows needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Automations"
        description="Trigger → conditions → actions. Every workflow can be dry-run against the last 7 days of real data before it goes live."
        actions={
          manages ? (
            <LinkButton href={`/w/${workspace.slug}/automations/new`} variant="primary">
              New workflow
            </LinkButton>
          ) : null
        }
      />

      {workflows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description={
            manages
              ? 'Create one to route messages, comments and records to the right place automatically.'
              : 'Managers, admins and owners create workflows. Once there is one, it appears here.'
          }
          action={
            manages ? (
              <LinkButton href={`/w/${workspace.slug}/automations/new`} variant="primary">
                New workflow
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-[var(--text-sm)]" data-testid="workflow-list">
            <thead className="border-b border-hairline text-[var(--text-xs)] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Trigger</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last run</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => {
                const trigger = w.trigger as { type?: string; platform?: string } | null;
                return (
                  <tr key={w.id} className="border-b border-hairline last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/w/${workspace.slug}/automations/${w.id}`}
                        className="font-medium text-link underline-offset-2 hover:underline"
                      >
                        {w.name}
                      </Link>
                      {w.description ? (
                        <p className="truncate text-[var(--text-xs)] text-ink-muted">
                          {w.description}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 font-mono text-[var(--text-xs)] text-ink-secondary">
                      {trigger?.type ?? '—'}
                      {trigger?.platform ? ` · ${trigger.platform}` : ''}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill tone={w.enabled ? 'good' : 'neutral'}>
                        {w.enabled ? 'Enabled' : 'Disabled'}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-2 text-ink-muted">
                      {isoOf(w.lastRunAt) ? (
                        <LocalDateTime iso={isoOf(w.lastRunAt)!} />
                      ) : (
                        'Never run'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
