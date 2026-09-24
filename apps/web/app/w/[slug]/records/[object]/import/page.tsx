import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { IMPORT_TONE } from '@/lib/import-status';
import { canImport } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { uploadCsvAction } from './actions';
import { UploadForm } from './upload-form';

export default async function ImportPage({
  params,
}: {
  params: Promise<{ slug: string; object: string }>;
}) {
  const { slug, object } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/records/${object}`;

  let objectType;
  try {
    objectType = await client.objectType.get({ objectType: object });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }
  if (!canImport(workspace.role)) {
    return (
      <PermissionDenied
        title="Importing needs a manager role or above"
        description="Imports create many records at once, so they are limited to managers, admins and owners."
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }
  const jobs = await client.import.list({ objectType: object });

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={
          <Link href={base} className="text-link hover:underline">
            {objectType.plural}
          </Link>
        }
        title={`Import ${objectType.plural.toLowerCase()} from CSV`}
        description="Upload a file, map its columns to attributes, review the dry run, then import. Every import can be rolled back."
      />

      <section aria-labelledby="upload-heading" className="flex flex-col gap-3">
        <h2 id="upload-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          1. Upload
        </h2>
        <UploadForm action={uploadCsvAction.bind(null, workspace.slug, object)} />
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h2 id="history-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Previous imports
        </h2>
        {jobs.length === 0 ? (
          <EmptyState
            compact
            title="No imports yet"
            description="Your first import will appear here with its result and a rollback button."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {jobs.map((j) => {
              const stats = (j.stats ?? {}) as Record<string, number>;
              return (
                <li
                  key={j.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[var(--text-sm)]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Link
                      href={`${base}/import/${j.id}`}
                      className="truncate font-medium text-link hover:underline"
                    >
                      {j.fileName}
                    </Link>
                    <StatusPill tone={IMPORT_TONE[j.status] ?? 'neutral'}>
                      {j.status.toLowerCase().replace('_', ' ')}
                    </StatusPill>
                  </div>
                  <div className="tnum text-ink-secondary">
                    {stats['created'] !== undefined
                      ? `${stats['created']} created`
                      : `${stats['total'] ?? 0} rows`}
                    {' · '}
                    <LocalDateTime iso={j.createdAt.toISOString()} />
                    {j.by ? ` · ${j.by}` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
