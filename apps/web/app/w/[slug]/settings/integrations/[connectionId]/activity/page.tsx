import { api } from '@/lib/api';
import { getWorkspace } from '@/lib/workspace';
import { ActivityView } from './activity-view';

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const [runs, deadLetters] = await Promise.all([
    client.connection.runs({ id: connectionId }),
    client.connection.deadLetters({ connectionId }),
  ]);
  return (
    <ActivityView connectionId={connectionId} initialRuns={runs} initialDeadLetters={deadLetters} />
  );
}
