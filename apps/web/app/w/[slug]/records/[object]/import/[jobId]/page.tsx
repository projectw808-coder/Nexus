import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/action-button';
import { ConfirmAction } from '@/components/confirm-action';
import { FormSubmit } from '@/components/form-submit';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { TYPE_LABEL } from '@/lib/attributes';
import { isCode } from '@/lib/errors';
import { canImport } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { IMPORT_TONE } from '@/lib/import-status';
import { previewFormAction, rollbackImportAction, runImportAction } from '../actions';

type Mapping = Record<string, { attributeId: string } | { skip: true }>;
type Stats = {
  total?: number;
  valid?: number;
  invalid?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
};
type RowError = { row: number; column: string | null; message: string };

export default async function ImportJobPage({
  params,
}: {
  params: Promise<{ slug: string; object: string; jobId: string }>;
}) {
  const { slug, object, jobId } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/records/${object}`;
  if (!canImport(workspace.role)) {
    return (
      <PermissionDenied
        title="Importing needs a manager role or above"
        currentRole={workspace.role}
        requiredRole="MANAGER"
      />
    );
  }

  let job;
  try {
    job = await client.import.get({ id: jobId });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    throw e;
  }
  const attrs = await client.attribute.list({ objectType: object });
  const writable = attrs.filter(
    (a) => a.access === 'WRITE' && !['FORMULA', 'ROLLUP', 'AI_RESEARCH'].includes(a.type),
  );
  const mapping = (job.mapping ?? {}) as Mapping;
  const headers = Object.keys(mapping);
  const stats = (job.stats ?? {}) as Stats;
  const errors = (Array.isArray(job.errors) ? job.errors : []) as RowError[];
  const options = (job.options ?? {}) as {
    dedupeAttributeId?: string | null;
    updateExisting?: boolean;
  };
  const canEditMapping = job.status === 'PREVIEW';
  const canRun = job.status === 'PREVIEW' || job.status === 'FAILED';
  const canRollback = job.status === 'COMPLETED' || job.status === 'FAILED';
  const validRows = stats.valid ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={
          <>
            <Link href={base} className="text-link hover:underline">
              {job.objectType.plural}
            </Link>{' '}
            ›{' '}
            <Link href={`${base}/import`} className="text-link hover:underline">
              Import
            </Link>
          </>
        }
        title={job.fileName}
        description={
          <span className="inline-flex items-center gap-2">
            <StatusPill tone={IMPORT_TONE[job.status] ?? 'neutral'}>
              {job.status.toLowerCase().replace('_', ' ')}
            </StatusPill>
            <span className="tnum">{stats.total ?? 0} rows</span>
          </span>
        }
      />

      <section aria-labelledby="mapping-heading" className="flex flex-col gap-3">
        <h2 id="mapping-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          2. Map columns
        </h2>
        <form
          action={previewFormAction.bind(null, workspace.slug, object, jobId, headers)}
          className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[var(--text-sm)]">
              <caption className="sr-only">Column mapping</caption>
              <thead className="border-b border-hairline text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    CSV column
                  </th>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    Attribute
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {headers.map((h) => {
                  const m = mapping[h];
                  const current = m && 'attributeId' in m ? m.attributeId : 'skip';
                  return (
                    <tr key={h}>
                      <td className="h-[var(--row-height)] px-[var(--cell-padding-x)] align-middle font-mono">
                        {h}
                      </td>
                      <td className="h-[var(--row-height)] px-[var(--cell-padding-x)] align-middle">
                        <label htmlFor={`map-${h}`} className="sr-only">
                          Attribute for {h}
                        </label>
                        <select
                          id={`map-${h}`}
                          name={`map:${h}`}
                          defaultValue={current}
                          disabled={!canEditMapping}
                          className="h-[var(--control-height)] w-full max-w-xs rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)] text-ink"
                        >
                          <option value="skip">— skip —</option>
                          {writable.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.title} ({TYPE_LABEL[a.type]})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dedupe" className="text-[var(--text-sm)] font-medium">
                Match existing records by
              </label>
              <select
                id="dedupe"
                name="dedupeAttributeId"
                defaultValue={options.dedupeAttributeId ?? ''}
                disabled={!canEditMapping}
                className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-sm)] text-ink"
              >
                <option value="">— always create —</option>
                {writable
                  .filter((a) => a.isUnique || ['EMAIL', 'TEXT', 'PHONE', 'URL'].includes(a.type))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
              </select>
            </div>
            <label className="inline-flex items-center gap-2 self-end pb-2 text-[var(--text-sm)]">
              <input
                type="checkbox"
                name="updateExisting"
                defaultChecked={options.updateExisting ?? false}
                disabled={!canEditMapping}
              />{' '}
              Update matched records (otherwise skip them)
            </label>
          </div>
          {canEditMapping ? (
            <div>
              <FormSubmit variant="secondary" pendingText="Checking…">
                Re-run preview
              </FormSubmit>
            </div>
          ) : null}
        </form>
      </section>

      <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
        <h2 id="preview-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          3. Dry run
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Rows" value={stats.total ?? 0} />
          <Stat label="Valid" value={stats.valid ?? 0} tone="good" />
          <Stat
            label="Invalid"
            value={stats.invalid ?? 0}
            tone={(stats.invalid ?? 0) > 0 ? 'critical' : undefined}
          />
          {job.status !== 'PREVIEW' ? (
            <Stat label="Created" value={stats.created ?? 0} />
          ) : (
            <Stat
              label="Unmapped columns"
              value={
                headers.filter((h) => {
                  const m = mapping[h];
                  return !m || 'skip' in m;
                }).length
              }
            />
          )}
        </dl>
        {errors.length > 0 ? (
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-hairline bg-card">
            <table className="w-full border-collapse text-[var(--text-sm)]">
              <caption className="px-[var(--cell-padding-x)] py-2 text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
                First {errors.length} problems (rows that fail are skipped, the rest still import)
              </caption>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {errors.map((e, i) => (
                  <tr key={i}>
                    <td className="tnum px-[var(--cell-padding-x)] py-1 align-top text-ink-muted">
                      row {e.row}
                    </td>
                    <td className="px-[var(--cell-padding-x)] py-1 align-top font-mono">
                      {e.column ?? '—'}
                    </td>
                    <td className="px-[var(--cell-padding-x)] py-1 align-top">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-secondary">
            No problems found in the dry run.
          </p>
        )}
      </section>

      <section aria-labelledby="run-heading" className="flex flex-col gap-3">
        <h2 id="run-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          4. Import
        </h2>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4">
          {canRun ? (
            <ActionButton
              variant="primary"
              size="md"
              pendingText="Importing…"
              disabled={validRows === 0}
              action={runImportAction.bind(null, workspace.slug, object, jobId)}
            >
              Import {validRows.toLocaleString()} {validRows === 1 ? 'row' : 'rows'}
            </ActionButton>
          ) : null}
          {job.status === 'COMPLETED' ? (
            <p className="text-[var(--text-sm)] text-ink-secondary">
              Done: {stats.created ?? 0} created, {stats.updated ?? 0} updated, {stats.skipped ?? 0}{' '}
              skipped, {stats.failed ?? 0} failed.{' '}
              <Link href={base} className="text-link hover:underline">
                Open {job.objectType.plural.toLowerCase()} →
              </Link>
            </p>
          ) : null}
          {job.status === 'ROLLED_BACK' ? (
            <p className="text-[var(--text-sm)] text-ink-secondary">
              This import was rolled back; the records it created are gone.
            </p>
          ) : null}
          {job.error ? <p className="text-[var(--text-sm)] text-critical">{job.error}</p> : null}
          {canRollback ? (
            <div className="ml-auto">
              <ConfirmAction
                label="Roll back this import"
                question={<>Remove every record this import created?</>}
                confirmLabel="Roll back"
                action={rollbackImportAction.bind(null, workspace.slug, object, jobId)}
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'good' | 'critical';
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-hairline bg-card px-4 py-3">
      <dt className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd
        className={`tnum text-[var(--text-lg)] font-semibold ${tone === 'good' ? 'text-good' : tone === 'critical' ? 'text-critical' : ''}`}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
