import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canDeleteRecords, canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { CannedRepliesView } from './canned-replies-view';

export const dynamic = 'force-dynamic';

/** Saved replies for the composer (§12.2.A): title, body, optional /shortcut and platform. */
export default async function CannedRepliesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let replies;
  try {
    replies = await client.cannedReply.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Canned replies are hidden from your role"
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  return (
    <CannedRepliesView
      initial={replies}
      canEdit={canWriteRecords(workspace.role)}
      canDelete={canDeleteRecords(workspace.role)}
    />
  );
}
