import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { AiSettingsView } from './ai-settings-view';

export default async function AiSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[var(--text-md)] font-semibold tracking-tight">AI</h2>
      <AiSettingsView canManage={canManage(workspace.role)} />
    </div>
  );
}
