import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { canManageWorkflows } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { WorkflowForm } from '../workflow-form';

export default async function NewWorkflowPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  if (!canManageWorkflows(workspace.role)) {
    return (
      <PermissionDenied
        title="You cannot create workflows"
        description="Owners, admins and managers create and edit workflows — they affect the whole team."
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="New workflow" />
      <WorkflowForm slug={workspace.slug} />
    </div>
  );
}
