import { CalendarClock, CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { Avatar, PriorityPill, StatusPill } from '@/components/client-pills';
import { DayLabel } from '@/components/day-label';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/clients';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

const DAY = 86_400_000;

/** Tasks & Follow-ups: every client's next follow-up, bucketed, plus open tasks. */
export default async function FollowUpsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const [data, tasks] = await Promise.all([
    client.clientWorkspace.all(),
    client.task.list({ includeDone: false }).catch(() => []),
  ]);
  const statusLabel = new Map(data.statuses.map((s) => [s.id, s.label]));
  const priorityLabel = new Map(data.priorities.map((p) => [p.id, p.label]));
  const agentName = new Map(data.agents.map((a) => [a.id, a.name ?? a.email]));

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const withDate = data.rows
    .filter((r) => r.nextFollowUp)
    .map((r) => ({ ...r, at: new Date(r.nextFollowUp!).getTime() }))
    .sort((a, b) => a.at - b.at);
  const buckets = [
    {
      title: 'Overdue',
      tone: 'text-[#ff8b8f]',
      rows: withDate.filter((r) => r.at < now.getTime()),
    },
    {
      title: 'Later today',
      tone: 'text-[#ffb13e]',
      rows: withDate.filter((r) => r.at >= now.getTime() && r.at < today + DAY),
    },
    {
      title: 'Next 7 days',
      tone: 'text-ink',
      rows: withDate.filter((r) => r.at >= today + DAY && r.at < today + 8 * DAY),
    },
    {
      title: 'Later',
      tone: 'text-ink-secondary',
      rows: withDate.filter((r) => r.at >= today + 8 * DAY),
    },
  ];
  const base = `/w/${workspace.slug}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tasks & Follow-ups"
        description="Every scheduled client follow-up, soonest first, and the team's open tasks."
      />

      {withDate.length === 0 ? (
        <div className="rounded-[9px] border border-hairline bg-card px-6 py-10 text-center text-[13.5px] text-ink-secondary">
          <CalendarClock aria-hidden size={22} className="mx-auto mb-2 text-ink-muted" />
          No follow-ups scheduled. Set a “Next follow-up” on a client in{' '}
          <Link href={`${base}/clients`} className="text-link hover:underline">
            Clients
          </Link>
          .
        </div>
      ) : (
        buckets
          .filter((b) => b.rows.length)
          .map((b) => (
            <section key={b.title} aria-labelledby={`fu-${b.title}`}>
              <h2 id={`fu-${b.title}`} className={`mb-2 text-[15px] font-semibold ${b.tone}`}>
                {b.title} <span className="font-normal text-ink-muted">({b.rows.length})</span>
              </h2>
              <ul className="overflow-hidden rounded-[9px] border border-hairline bg-card">
                {b.rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-hairline px-4 py-2.5 text-[13px] last:border-b-0"
                  >
                    <Avatar name={r.name} size={30} />
                    <Link
                      href={`${base}/clients?client=${r.id}`}
                      className="min-w-[160px] font-semibold hover:text-link"
                    >
                      {r.name}
                    </Link>
                    <StatusPill
                      id={r.status}
                      label={r.status ? statusLabel.get(r.status) : undefined}
                    />
                    <PriorityPill
                      id={r.priority}
                      label={r.priority ? priorityLabel.get(r.priority) : undefined}
                    />
                    <span className="tnum text-ink-secondary">{formatPhone(r.phone)}</span>
                    <span className="text-ink-secondary">
                      {r.ownerId ? (agentName.get(r.ownerId) ?? 'Unknown') : 'Unassigned'}
                    </span>
                    <span className="ml-auto font-medium">
                      <DayLabel iso={r.nextFollowUp} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
      )}

      <section aria-labelledby="open-tasks">
        <h2 id="open-tasks" className="mb-2 text-[15px] font-semibold">
          Open tasks <span className="font-normal text-ink-muted">({tasks.length})</span>
        </h2>
        {tasks.length === 0 ? (
          <p className="rounded-[9px] border border-hairline bg-card px-4 py-6 text-center text-[13px] text-ink-secondary">
            <CircleCheck aria-hidden size={18} className="mx-auto mb-1.5 text-ink-muted" />
            No open tasks.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-[9px] border border-hairline bg-card">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline px-4 py-2.5 text-[13px] last:border-b-0"
              >
                <span className="min-w-[200px] flex-1 font-medium">{t.title}</span>
                <span className="text-ink-secondary">
                  {t.assignee?.name ?? t.assignee?.email ?? 'Unassigned'}
                </span>
                <span className={t.overdue ? 'font-medium text-[#ff8b8f]' : 'text-ink-secondary'}>
                  {t.dueAt ? <DayLabel iso={new Date(t.dueAt).toISOString()} /> : 'No due date'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
