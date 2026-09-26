import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';
import { DataResourcesView } from './data-resources-view';

export default async function DataResourcesPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const connection = await client.connection.get({ id: connectionId });
  return <DataResourcesView connectionId={connectionId} initial={connection} />;
}
