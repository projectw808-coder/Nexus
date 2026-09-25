import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { getWorkspace } from '@/lib/workspace';
import { InboxView } from './inbox-view';

export const dynamic = 'force-dynamic';

/**
 * Phase 5 scaffold (§16): a bare conversation list with a thread pane and a composer that
 * enforces the platform's messaging window. The full inbox (triage, assignment, SLA, snooze)
 * is Phase 7; this page exists so a DM from a phone can be seen and answered end to end.
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
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let conversations;
  try {
    conversations = await client.conversation.list();
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
  const connections = await client.connection.list().catch(() => []);
  const selected = c && conversations.some((x) => x.id === c) ? c : (conversations[0]?.id ?? null);

  return (
    <div className="flex h-full flex-col gap-6">
      <PageHeader
        title="Inbox"
        description="Every DM, comment thread and mention from your connected accounts, newest first. Replies go out through the platform."
      />
      <InboxView
        slug={workspace.slug}
        initialConversations={conversations}
        initialSelectedId={selected}
        hasConnections={connections.length > 0}
      />
    </div>
  );
}
