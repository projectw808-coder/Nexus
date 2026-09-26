import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { getWorkspace } from '@/lib/workspace';
import { PermissionsView } from './permissions-view';

export default async function PermissionsPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let grants;
  try {
    grants = await client.connectionGrant.list({ connectionId });
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Permissions are hidden from your role"
          description="Only owners and admins can see or change who has extra access to a connection."
          currentRole={workspace.role}
          requiredRole="ADMIN"
        />
      );
    }
    throw e;
  }
  const members = await client.member.list();
  return <PermissionsView connectionId={connectionId} initialGrants={grants} members={members} />;
}
