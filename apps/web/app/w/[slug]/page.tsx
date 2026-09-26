import Link from 'next/link';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { LinkButton } from '@/components/button';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isoOf } from '@/lib/format';
import { canManageWorkflows } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

/**
 * Home (§12.1): "today's work" — assigned conversations, due tasks, SLA risk, stalled deals —
 * plus a short onboarding checklist for a workspace that hasn't connected anything yet. This
 * replaces the Phase 1 placeholder that had sat here since the tenant boundary was the only
 * thing built; every query below already existed by Phase 10, this just puts them on one screen.
 */
export default async function WorkspaceHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const base = `/w/${workspace.slug}`;
  const client = await api(workspace.slug);

  const [connections, members, workflows, assigned, atRisk, tasks, stalled] = await Promise.all([
    client.connection.list().catch(() => []),
    client.member.list().catch(() => []),
    client.workflow.list().catch(() => []),
    client.conversation.list({ assignee: 'me', status: 'OPEN', limit: 5 }).catch(() => null),
    client.conversation.list({ sla: 'due_soon', status: 'OPEN', limit: 5 }).catch(() => null),
    client.task.list({ mine: true, includeDone: false }).catch(() => []),
    client.list.stalled({ days: 14, limit: 5 }).catch(() => []),
  ]);

  const checklist = [
    {
      done: connections.length > 0,
      label: 'Connect a platform',
      href: `${base}/settings/integrations`,
    },
    { done: members.length > 1, label: 'Invite a teammate', href: `${base}/settings/members` },
    { done: workflows.length > 0, label: 'Create an automation', href: `${base}/automations` },
    { done: false, label: 'Explore reports', href: `${base}/reports` },
  ];
  const remaining = checklist.filter((c) => !c.done);

  const nothingToShow =
    (assigned?.items.length ?? 0) === 0 &&
    (atRisk?.items.length ?? 0) === 0 &&
    tasks.length === 0 &&
    stalled.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={workspace.name} description="Home" />

      {remaining.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4" aria-label="Getting started">
          <h2 className="text-[var(--text-sm)] font-semibold">Getting started</h2>
          <ul className="flex flex-wrap gap-2">
            {checklist.map((c) => (
              <li key={c.label}>
                <Link
                  href={c.href}
                  className={`inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-hairline px-3 py-1 text-[var(--text-xs)] ${
                    c.done ? 'text-ink-muted line-through' : 'text-link hover:underline'
                  }`}
                >
                  <span aria-hidden>{c.done ? '✓' : '○'}</span>
                  {c.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {nothingToShow ? (
        <EmptyState
          title="Nothing needs you right now"
          description="Assigned conversations, due tasks, SLA risk and stalled deals will show up here."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-2 p-4" data-testid="home-assigned">
            <h2 className="text-[var(--text-sm)] font-semibold">Assigned to you</h2>
            {!assigned || assigned.items.length === 0 ? (
              <p className="text-[var(--text-xs)] text-ink-muted">Nothing assigned to you.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[var(--text-sm)]">
                {assigned.items.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`${base}/inbox?conversation=${c.id}`}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {c.subject ?? c.person?.label ?? 'Conversation'}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="flex flex-col gap-2 p-4" data-testid="home-sla">
            <h2 className="text-[var(--text-sm)] font-semibold">SLA risk</h2>
            {!atRisk || atRisk.items.length === 0 ? (
              <p className="text-[var(--text-xs)] text-ink-muted">Nothing at risk.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[var(--text-sm)]">
                {atRisk.items.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <Link
                      href={`${base}/inbox?conversation=${c.id}`}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {c.subject ?? c.person?.label ?? 'Conversation'}
                    </Link>
                    {isoOf(c.slaDueAt) ? (
                      <StatusPill tone="warning">
                        <LocalDateTime iso={isoOf(c.slaDueAt)!} />
                      </StatusPill>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="flex flex-col gap-2 p-4" data-testid="home-tasks">
            <h2 className="text-[var(--text-sm)] font-semibold">Due tasks</h2>
            {tasks.length === 0 ? (
              <p className="text-[var(--text-xs)] text-ink-muted">No open tasks assigned to you.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[var(--text-sm)]">
                {tasks.slice(0, 5).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span>{t.title}</span>
                    {t.overdue ? <StatusPill tone="critical">Overdue</StatusPill> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="flex flex-col gap-2 p-4" data-testid="home-stalled">
            <h2 className="text-[var(--text-sm)] font-semibold">Stalled deals</h2>
            {stalled.length === 0 ? (
              <p className="text-[var(--text-xs)] text-ink-muted">
                Nothing has gone quiet in a pipeline.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[var(--text-sm)]">
                {stalled.map((s) => (
                  <li key={s.entryId} className="flex items-center justify-between gap-2">
                    <Link
                      href={`${base}/records/deal/${s.recordId}`}
                      className="truncate text-link underline-offset-2 hover:underline"
                    >
                      {s.label}
                    </Link>
                    <span className="shrink-0 text-[var(--text-xs)] text-ink-muted">
                      {s.listName} · {s.stage}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {canManageWorkflows(workspace.role) ? (
        <LinkButton href={`${base}/settings/integrations`} variant="secondary" className="w-fit">
          Manage integrations
        </LinkButton>
      ) : null}
    </div>
  );
}
