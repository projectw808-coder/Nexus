import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { RecordForm } from '@/components/record-form';
import type { SearchRecords } from '@/components/record-search';
import { api } from '@/lib/api';
import { targetObjectTypeIdOf } from '@/lib/attributes';
import { isCode } from '@/lib/errors';
import { canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { searchRecordsAction } from '../../actions';
import { createRecordAction } from '../actions';

export default async function NewRecordPage({
  params,
}: {
  params: Promise<{ slug: string; object: string }>;
}) {
  const { slug, object } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/records/${object}`;

  let ot;
  try {
    ot = await client.objectType.get({ objectType: object });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }

  if (!canWriteRecords(workspace.role)) {
    return (
      <PermissionDenied
        title={`Viewers cannot create ${ot.plural.toLowerCase()}`}
        description="Creating records needs the member role or above."
        currentRole={workspace.role}
        requiredRole="MEMBER"
      />
    );
  }

  const objectTypes = await client.objectType.list();
  const searches: Record<string, SearchRecords> = {};
  for (const a of ot.attributes) {
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
            <Link href={base}>{ot.plural}</Link>
          </>
        }
        title={`New ${ot.singular.toLowerCase()}`}
        description="Required attributes are marked with an asterisk. Everything else can be filled in later."
      />
      <RecordForm
        action={createRecordAction.bind(null, workspace.slug, object)}
        attributes={ot.attributes}
        initial={{}}
        slug={workspace.slug}
        objectTypes={objectTypes}
        searches={searches}
        submitLabel={`Create ${ot.singular.toLowerCase()}`}
        pendingLabel="Creating…"
        cancelHref={base}
      />
    </div>
  );
}
