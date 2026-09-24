import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { RecordForm } from '@/components/record-form';
import type { SearchRecords } from '@/components/record-search';
import { api } from '@/lib/api';
import { targetObjectTypeIdOf } from '@/lib/attributes';
import { isCode } from '@/lib/errors';
import { canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { searchRecordsAction } from '../../../actions';
import { updateRecordAction } from '../../actions';

export default async function EditRecordPage({
  params,
}: {
  params: Promise<{ slug: string; object: string; id: string }>;
}) {
  const { slug, object, id } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/records/${object}`;

  let rec;
  try {
    rec = await client.record.get({ id });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND', 'BAD_REQUEST')) notFound();
    throw e;
  }
  if (rec.objectType.apiSlug !== object) notFound();

  if (!canWriteRecords(workspace.role)) {
    return (
      <PermissionDenied
        title="Viewers cannot edit records"
        description="Editing needs the member role or above."
        currentRole={workspace.role}
        requiredRole="MEMBER"
        action={
          <LinkButton href={`${base}/${rec.id}`} variant="secondary">
            Back to the record
          </LinkButton>
        }
      />
    );
  }

  if (rec.deletedAt) {
    return (
      <EmptyState
        title="This record is deleted"
        description="Restore it from its page before editing."
        action={
          <LinkButton href={`${base}/${rec.id}`} variant="primary">
            Open the record
          </LinkButton>
        }
      />
    );
  }

  const objectTypes = await client.objectType.list();
  const attrs = [...rec.attributes].sort((a, b) => a.position - b.position);
  const searches: Record<string, SearchRecords> = {};
  for (const a of attrs) {
    const target = a.type === 'RELATIONSHIP' ? targetObjectTypeIdOf(a.config) : null;
    if (target && !searches[target])
      searches[target] = searchRecordsAction.bind(null, workspace.slug, target);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <>
            <Link href={`/w/${workspace.slug}/records`}>Records</Link> /{' '}
            <Link href={base}>{rec.objectType.plural}</Link> /{' '}
            <Link href={`${base}/${rec.id}`}>{rec.label}</Link>
          </>
        }
        title={`Edit ${rec.label}`}
        description="Attributes your role may only read are shown but not editable."
      />
      <RecordForm
        action={updateRecordAction.bind(null, workspace.slug, object, rec.id)}
        attributes={attrs}
        initial={rec.values}
        slug={workspace.slug}
        objectTypes={objectTypes}
        searches={searches}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        cancelHref={`${base}/${rec.id}`}
      />
    </div>
  );
}
