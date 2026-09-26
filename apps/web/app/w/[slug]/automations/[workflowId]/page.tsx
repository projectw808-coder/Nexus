import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageWorkflows } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { WorkflowView } from './workflow-view';

export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ slug: string; workflowId: string }>;
}) {
  const { slug, workflowId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);

  let workflow;
  try {
    workflow = await client.workflow.get({ id: workflowId });
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="This workflow is closed to your role"
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/w/${workspace.slug}/automations`}
        className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
      >
        ← Automations
      </Link>
      <PageHeader title={workflow.name} description={workflow.description ?? undefined} />
      <WorkflowView
        slug={workspace.slug}
        canManage={canManageWorkflows(workspace.role)}
        workflow={
          workflow as unknown as {
            id: string;
            name: string;
            description: string | null;
            trigger: {
              type: string;
              platform?: string;
              objectTypeApiSlug?: string;
              listId?: string;
            };
            conditions: unknown;
            actions: unknown;
            enabled: boolean;
            version: number;
          }
        }
      />
    </div>
  );
}
