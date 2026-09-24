import Link from 'next/link';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canEditSchema } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { createObjectAction, deleteObjectAction } from './actions';
import { NewObjectForm } from './new-object-form';

export default async function ObjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/settings/objects`;
  const edits = canEditSchema(workspace.role);

  let objects;
  try {
    objects = await client.objectType.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Objects are closed to your role"
          description="Reading the schema needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        as="h2"
        title="Objects & attributes"
        description="People, companies and deals are built in. Add your own objects and attributes without code; deletions stay reversible for 24 hours."
      />

      {objects.length === 0 ? (
        <EmptyState title="No objects" description="Create one below." />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-hairline bg-card">
          <table className="w-full border-collapse text-[var(--text-sm)]">
            <caption className="sr-only">Object types</caption>
            <thead className="border-b border-hairline text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
              <tr>
                <th
                  scope="col"
                  className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                >
                  Object
                </th>
                <th
                  scope="col"
                  className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                >
                  Slug
                </th>
                <th
                  scope="col"
                  className="h-[var(--row-height)] px-[var(--cell-padding-x)] text-right font-medium"
                >
                  Attributes
                </th>
                <th
                  scope="col"
                  className="h-[var(--row-height)] px-[var(--cell-padding-x)] text-right font-medium"
                >
                  Records
                </th>
                <th
                  scope="col"
                  className="h-[var(--row-height)] px-[var(--cell-padding-x)] text-right font-medium"
                >
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-hairline)]">
              {objects.map((o) => (
                <tr key={o.id} className="hover:bg-raised">
                  <td className="h-[var(--row-height)] px-[var(--cell-padding-x)] align-middle">
                    <Link
                      href={`${base}/${o.apiSlug}`}
                      className="font-medium text-link hover:underline"
                    >
                      {o.plural}
                    </Link>
                    {o.isSystem ? (
                      <span className="ml-2 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4 text-ink-muted">
                        system
                      </span>
                    ) : null}
                    {o.description ? (
                      <p className="text-[var(--text-xs)] text-ink-muted">{o.description}</p>
                    ) : null}
                  </td>
                  <td className="h-[var(--row-height)] px-[var(--cell-padding-x)] align-middle font-mono text-ink-secondary">
                    {o.apiSlug}
                  </td>
                  <td className="tnum h-[var(--row-height)] px-[var(--cell-padding-x)] text-right align-middle">
                    {o.attributeCount}
                  </td>
                  <td className="tnum h-[var(--row-height)] px-[var(--cell-padding-x)] text-right align-middle">
                    {o.recordCount.toLocaleString()}
                  </td>
                  <td className="h-[var(--row-height)] px-[var(--cell-padding-x)] text-right align-middle">
                    {edits ? (
                      <ConfirmAction
                        label="Delete"
                        question={
                          <>
                            Delete {o.plural}? Records stay but are hidden; attributes are
                            restorable for 24 hours.
                          </>
                        }
                        confirmLabel="Delete object"
                        action={deleteObjectAction.bind(null, workspace.slug, o.id)}
                        disabled={o.isSystem}
                        disabledReason={`${o.singular} is a system object and cannot be deleted.`}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="new-object-heading" className="flex flex-col gap-3">
        <h3 id="new-object-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          New object
        </h3>
        {edits ? (
          <NewObjectForm action={createObjectAction.bind(null, workspace.slug)} />
        ) : (
          <PermissionNote>
            Only owners and admins change the schema. You are a {workspace.role.toLowerCase()}.
          </PermissionNote>
        )}
      </section>
    </div>
  );
}
