import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageLists } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { createListAction } from './actions';
import { NewListForm } from './new-list-form';

export default async function ListsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/lists`;

  let lists;
  try {
    lists = await client.list.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Lists are closed to your role"
          description="Reading lists needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  const objectTypes = await client.objectType.list();
  const manages = canManageLists(workspace.role);

  const groups = objectTypes
    .map((o) => ({ object: o, lists: lists.filter((l) => l.objectTypeId === o.id) }))
    .filter((g) => g.lists.length > 0);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Lists"
        description="Pipelines move records through stages; collections simply group them. A record can sit in many lists."
      />

      {lists.length === 0 ? (
        <EmptyState
          title="No lists yet"
          description={
            manages
              ? 'Create a pipeline for deals, or a collection for any object, below.'
              : 'Managers, admins and owners create lists. Once there is one, it appears here.'
          }
        />
      ) : (
        groups.map((g) => (
          <section
            key={g.object.id}
            aria-labelledby={`lists-${g.object.apiSlug}`}
            className="flex flex-col gap-3"
          >
            <h2
              id={`lists-${g.object.apiSlug}`}
              className="text-[var(--text-md)] font-semibold tracking-tight"
            >
              {g.object.plural}{' '}
              <span className="tnum font-normal text-ink-muted">({g.lists.length})</span>
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.lists.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`${base}/${l.id}`}
                    className="flex h-full flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-4 transition-colors duration-[var(--duration-state)] hover:border-strong"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[var(--text-md)] font-semibold tracking-tight">
                        {l.name}
                      </span>
                      <span className="shrink-0 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4 text-ink-muted">
                        {l.kind === 'PIPELINE' ? 'pipeline' : 'collection'}
                      </span>
                    </div>
                    {l.description ? (
                      <p className="text-[var(--text-sm)] text-ink-secondary">{l.description}</p>
                    ) : null}
                    <p className="mt-auto text-[var(--text-sm)] text-ink-muted">
                      <span className="tnum font-medium text-ink">{l.entryCount}</span>{' '}
                      {l.entryCount === 1 ? 'entry' : 'entries'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <section aria-labelledby="new-list-heading" className="flex flex-col gap-3">
        <h2 id="new-list-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          New list
        </h2>
        {manages ? (
          <NewListForm
            action={createListAction.bind(null, workspace.slug)}
            objectTypes={objectTypes}
          />
        ) : (
          <PermissionNote>
            Only managers, admins and owners create lists. You are a {workspace.role.toLowerCase()}.
          </PermissionNote>
        )}
      </section>
    </div>
  );
}
