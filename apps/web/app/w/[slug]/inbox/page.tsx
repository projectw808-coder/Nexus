import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canWriteRecords } from '@/lib/roles';
import { requireSessionUser } from '@/lib/session';
import { getWorkspace } from '@/lib/workspace';
import { InboxView } from './inbox-view';

export const dynamic = 'force-dynamic';

/**
 * The unified inbox (§12.2.A): three panes, per-platform tabs, assignment, statuses, snooze,
 * SLA timers, internal notes, canned replies, the platform-aware composer, the context
 * sidebar (Phase 6), SSE realtime, the keyboard model and bulk triage.
 */
export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { slug } = await params;
  const { c } = await searchParams;
  const user = await requireSessionUser();
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let connections;
  try {
    connections = await client.connection.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="The inbox is closed to your role"
          description="Reading conversations needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  const [members, canned, views] = await Promise.all([
    client.member.list().catch(() => []),
    client.cannedReply.list().catch(() => []),
    client.view.list({ scope: 'inbox' }).catch(() => []),
  ]);
  const writes = canWriteRecords(workspace.role);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="Inbox"
        description="Every DM, comment thread and mention from your connected accounts, live. j/k move, r reply, a assign, s snooze, e close, n note."
      />
      <InboxView
        slug={workspace.slug}
        selfId={user.id}
        initialSelectedId={c ?? null}
        connections={connections}
        members={members}
        canned={canned}
        views={views}
        canTriage={writes}
        canNote={writes}
        canWriteRecords={writes}
      />
    </div>
  );
}
