import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';
import { MappingView } from './mapping-view';

export default async function MappingPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const connection = await client.connection.get({ id: connectionId });
  const [mappings, objectTypes] = await Promise.all([
    client.fieldMapping.list({ platform: connection.platform }),
    client.objectType.list(),
  ]);
  return (
    <MappingView
      connectionId={connectionId}
      platform={connection.platform}
      initialMappings={mappings}
      objectTypes={objectTypes}
    />
  );
}
