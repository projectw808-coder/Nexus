import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';
import { WebhooksView } from './webhooks-view';

export default async function WebhooksPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const events = await client.webhookEvent.list({ connectionId });
  return <WebhooksView connectionId={connectionId} initial={events} />;
}
