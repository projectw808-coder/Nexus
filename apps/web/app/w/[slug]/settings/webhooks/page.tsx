import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { OutboundWebhooksView } from './outbound-webhooks-view';

export const dynamic = 'force-dynamic';

/**
 * Outbound webhooks (§11.2): subscriptions with a signing secret shown exactly once, and the
 * signed-delivery log with replay. Owner/admin only — see server/abilities.ts.
 */
export default async function OutboundWebhooksPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let data;
  try {
    const [subscriptions, catalog] = await Promise.all([
      client.outboundWebhook.list(),
      client.outboundWebhook.catalog(),
    ]);
    data = { subscriptions, catalog };
  } catch (e) {
    if (!isCode(e, 'FORBIDDEN')) throw e;
  }
  if (!data) {
    return (
      <PermissionDenied
        title="Webhooks are hidden from your role"
        description="Outbound webhooks hand a third party a copy of this workspace's events, and creating one reveals a signing secret."
        currentRole={workspace.role}
        requiredRole="ADMIN"
      />
    );
  }
  return (
    <OutboundWebhooksView
      initial={data.subscriptions}
      catalog={data.catalog}
      canManage={canManage(workspace.role)}
    />
  );
}
