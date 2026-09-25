import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { identityLabel, platformName } from '@/lib/platforms';
import { canLinkIdentities, canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { IdentityView } from './identity-view';

export const dynamic = 'force-dynamic';

/**
 * One channel identity (§6.3, §10): who it is on the platform, which person it resolved to and
 * why, its handle history, the people it could belong to (scored live), and its own timeline —
 * visible before resolution and moved, not copied, to the person afterwards (ADR-003).
 */
export default async function IdentityPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let identity;
  try {
    identity = await client.identity.get({ id });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND', 'BAD_REQUEST')) notFound();
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Identities are closed to your role"
          description="Reading channel identities needs a role that can see records."
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
        eyebrow={
          <>
            <Link href={`/w/${workspace.slug}/duplicates`}>Duplicates &amp; identities</Link> /{' '}
            {platformName(identity.platform)}
          </>
        }
        title={identityLabel(identity)}
        description={
          identity.person ? (
            <>
              Resolved to{' '}
              <Link
                href={`/w/${workspace.slug}/records/person/${identity.person.id}`}
                className="text-link underline-offset-2 hover:underline"
              >
                {identity.person.label}
              </Link>
              .
            </>
          ) : (
            'Not linked to a person yet. Its history stays here until it is.'
          )
        }
      />
      <IdentityView
        slug={workspace.slug}
        initial={identity}
        canLink={canLinkIdentities(workspace.role)}
        canCreate={canWriteRecords(workspace.role)}
      />
    </div>
  );
}
