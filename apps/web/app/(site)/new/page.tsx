import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { requireSessionUser } from '@/lib/session';
import { createWorkspaceAction } from './actions';
import { NewWorkspaceForm } from './new-workspace-form';

export const dynamic = 'force-dynamic';

export default async function NewWorkspacePage() {
  await requireSessionUser();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href="/" className="hover:text-ink">
            ← Workspaces
          </Link>
        }
        title="New workspace"
        description="A workspace is the tenant boundary: its own members, records, integrations and audit log."
      />
      <NewWorkspaceForm action={createWorkspaceAction} />
    </div>
  );
}
