import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { AssistantChat } from './assistant-chat';

export const dynamic = 'force-dynamic';

/** The admin AI assistant (owner/admin only): chat that can create/edit Client records and
 * answer integration questions. Everyone else is turned away before the chat ever renders. */
export default async function AssistantPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);

  if (!canManage(workspace.role)) {
    return (
      <PermissionDenied
        title="The AI assistant is owner/admin only"
        description="It can create and edit client records and discusses integration credentials, so it's limited to workspace owners and admins."
        currentRole={workspace.role}
        requiredRole="ADMIN"
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI assistant"
        description="Ask it to add or update a client, or ask what's connected. It only acts on what you ask — nothing runs in the background."
      />
      <AssistantChat workspaceSlug={workspace.slug} />
    </div>
  );
}
