import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageDsr, canRecordConsent } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { ComplianceView } from './compliance-view';

export const dynamic = 'force-dynamic';

/**
 * Compliance (§5.5): the data-subject-request queue, consent per identity and channel, and the
 * platform terms constraints that apply to whatever this workspace has connected.
 */
export default async function CompliancePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);

  let initial;
  try {
    const [requests, consent, notes, identities] = await Promise.all([
      client.dataSubjectRequest.list({}),
      client.consent.list({}),
      client.complianceNote.list({}),
      client.identity.list({ limit: 100 }),
    ]);
    initial = { requests, consent, notes, identities };
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Compliance is hidden from your role"
          description="Data-subject requests name the people who filed them, so reading this queue needs a manager, admin or owner."
          currentRole={workspace.role}
          requiredRole="MANAGER"
        />
      );
    }
    throw e;
  }

  return (
    <ComplianceView
      initial={initial}
      canManageRequests={canManageDsr(workspace.role)}
      canRecordConsent={canRecordConsent(workspace.role)}
      role={workspace.role}
    />
  );
}
