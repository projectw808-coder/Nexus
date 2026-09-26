import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';
import { DangerView } from './danger-view';

export default async function DangerZonePage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const connection = await client.connection.get({ id: connectionId });
  return (
    <DangerView
      workspaceSlug={workspace.slug}
      connectionId={connectionId}
      connectionLabel={connection.label}
    />
  );
}
