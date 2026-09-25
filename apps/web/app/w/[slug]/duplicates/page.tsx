import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canLinkIdentities, canReviewMerges } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { DuplicatesView } from './duplicates-view';

export const dynamic = 'force-dynamic';

/**
 * The merge review queue and the unresolved identities (§10): every suggestion the resolver
 * could not decide on its own, with its evidence, accepted or rejected from the keyboard.
 */
export default async function DuplicatesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let queue;
  let unresolved;
  try {
    [queue, unresolved] = await Promise.all([
      client.mergeSuggestion.list(),
      client.identity.list({ unresolved: true, limit: 100 }),
    ]);
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Duplicates are closed to your role"
          description="Reviewing merge suggestions needs a role that can read records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Duplicates & identities"
        description="People the resolver thinks might be the same, with the evidence, and platform accounts it could not place. j/k to move, a to accept, r to reject, Enter to open."
      />
      <DuplicatesView
        slug={workspace.slug}
        initialQueue={queue}
        initialUnresolved={unresolved}
        canReview={canReviewMerges(workspace.role)}
        canLink={canLinkIdentities(workspace.role)}
      />
    </div>
  );
}
