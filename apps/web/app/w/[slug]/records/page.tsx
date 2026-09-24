import Link from 'next/link';
import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canEditSchema } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';

/** Records home: one card per object type with its record count. */
export default async function RecordsIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const base = `/w/${workspace.slug}`;
  const client = await api(workspace.slug);

  let objects;
  try {
    objects = await client.objectType.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Records are closed to your role"
          description="Reading object types needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  const schema = canEditSchema(workspace.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Records"
        description="Every object in the workspace, with the people, companies and deals it holds."
        actions={
          schema ? (
            <LinkButton href={`${base}/settings/objects`} variant="secondary">
              New object
            </LinkButton>
          ) : undefined
        }
      />
      {objects.length === 0 ? (
        <EmptyState
          title="No objects yet"
          description="Objects are the shapes records take — people, companies, deals, or anything you define."
          action={
            schema ? (
              <LinkButton href={`${base}/settings/objects`} variant="primary">
                Create the first object
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Object types">
          {objects.map((o) => (
            <li key={o.id}>
              <Link
                href={`${base}/records/${o.apiSlug}`}
                className="flex h-full flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4 transition-colors duration-[var(--duration-state)] hover:border-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-raised text-[var(--text-sm)] font-semibold uppercase text-ink-secondary"
                    >
                      {o.singular.slice(0, 1)}
                    </span>
                    <span className="text-[var(--text-md)] font-semibold tracking-tight">
                      {o.plural}
                    </span>
                  </div>
                  {o.isSystem ? (
                    <span className="rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4 text-ink-muted">
                      system
                    </span>
                  ) : null}
                </div>
                {o.description ? (
                  <p className="text-[var(--text-sm)] text-ink-secondary">{o.description}</p>
                ) : null}
                <dl className="mt-auto flex gap-5 text-[var(--text-sm)] text-ink-secondary">
                  <div className="flex gap-1.5">
                    <dt className="text-ink-muted">Records</dt>
                    <dd className="tnum font-medium text-ink">
                      {o.recordCount.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-ink-muted">Attributes</dt>
                    <dd className="tnum font-medium text-ink">{o.attributeCount}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
