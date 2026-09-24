import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { canReadAudit } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

export default async function WorkspaceHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const base = `/w/${workspace.slug}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={workspace.name} description="Home" />
      <EmptyState
        title="Nothing is wired up yet"
        description="Phase 1 is the tenant boundary: members, roles, invitations and the audit trail. Records, the inbox and integrations arrive in the phases the rail announces."
        action={
          <>
            <LinkButton href={`${base}/settings/members`} variant="primary">
              Members
            </LinkButton>
            {canReadAudit(workspace.role) ? (
              <LinkButton href={`${base}/settings/audit`} variant="secondary">
                Audit log
              </LinkButton>
            ) : null}
            <LinkButton href={`${base}/settings/general`} variant="secondary">
              General settings
            </LinkButton>
          </>
        }
      />
    </div>
  );
}
