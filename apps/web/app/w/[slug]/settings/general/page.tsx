import { PermissionNote } from '@/components/permission-denied';
import { RoleBadge } from '@/components/role-badge';
import { formatDateTime, isoOf } from '@/lib/format';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { renameWorkspaceAction } from './actions';
import { RenameForm } from './rename-form';

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-center gap-4 border-b border-hairline py-2.5 last:border-b-0">
      <dt className="text-[var(--text-sm)] text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-[var(--text-sm)]' : ''}>{children}</dd>
    </div>
  );
}

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const manages = canManage(workspace.role);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="name-heading" className="flex flex-col gap-3">
        <h2 id="name-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Name
        </h2>
        {manages ? (
          <RenameForm
            action={renameWorkspaceAction.bind(null, workspace.slug)}
            initialName={workspace.name}
          />
        ) : (
          <>
            <p className="text-[var(--text-md)]">{workspace.name}</p>
            <PermissionNote>
              Only owners and admins can rename the workspace. You are a{' '}
              {workspace.role.toLowerCase()}.
            </PermissionNote>
          </>
        )}
      </section>

      <section aria-labelledby="details-heading" className="flex flex-col gap-3">
        <h2 id="details-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Details
        </h2>
        <dl className="max-w-lg rounded-[var(--radius-card)] border border-hairline bg-card px-4">
          <Row label="Slug" mono>
            {workspace.slug}
          </Row>
          <Row label="Plan">{workspace.plan.toLowerCase()}</Row>
          <Row label="Region">{workspace.region}</Row>
          <Row label="Your role">
            <RoleBadge role={workspace.role} />
          </Row>
          <Row label="Created">
            <time dateTime={isoOf(workspace.createdAt)}>{formatDateTime(workspace.createdAt)}</time>
          </Row>
        </dl>
        <p className="text-[var(--text-sm)] text-ink-muted">
          Slug, plan and region are fixed for now.
        </p>
      </section>
    </div>
  );
}
