import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/action-button';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { TYPE_LABEL, isIndexable } from '@/lib/attributes';
import { isCode } from '@/lib/errors';
import { ROLES, canEditSchema } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import {
  createAttributeAction,
  deleteAttributeAction,
  reorderAttributeAction,
  restoreAttributeAction,
  setIndexedAction,
  setPermissionAction,
} from './actions';
import { AttributeForm } from './attribute-form';
import { PermissionSelect } from './permission-select';

export default async function ObjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string; object: string }>;
}) {
  const { slug, object } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const edits = canEditSchema(workspace.role);

  let detail;
  try {
    detail = await client.objectType.get({ objectType: object });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Objects are closed to your role"
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  const objectTypes = await client.objectType.list();
  const orderedIds = detail.attributes.map((a) => a.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        as="h2"
        eyebrow={
          <Link
            href={`/w/${workspace.slug}/settings/objects`}
            className="text-link hover:underline"
          >
            Objects
          </Link>
        }
        title={detail.plural}
        description={
          <>
            <span className="font-mono">{detail.apiSlug}</span> ·{' '}
            {detail.recordCount.toLocaleString()} {detail.recordCount === 1 ? 'record' : 'records'}
            {detail.isSystem
              ? ' · system object: its core attributes can be renamed but not deleted or retyped.'
              : ''}
          </>
        }
        actions={
          <Link
            href={`/w/${workspace.slug}/records/${detail.apiSlug}`}
            className="text-[var(--text-sm)] text-link hover:underline"
          >
            Open records →
          </Link>
        }
      />

      <section aria-labelledby="attributes-heading" className="flex flex-col gap-3">
        <h3 id="attributes-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Attributes{' '}
          <span className="tnum font-normal text-ink-muted">({detail.attributes.length})</span>
        </h3>
        {detail.attributes.length === 0 ? (
          <EmptyState compact title="No attributes" description="Add one below." />
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-hairline bg-card">
            <table className="w-full border-collapse text-[var(--text-sm)]">
              <caption className="sr-only">Attributes of {detail.plural}</caption>
              <thead className="border-b border-hairline text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    Attribute
                  </th>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    Type
                  </th>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    Rules
                  </th>
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                  >
                    Index
                  </th>
                  {edits ? (
                    <th
                      scope="col"
                      className="h-[var(--row-height)] px-[var(--cell-padding-x)] font-medium"
                    >
                      Access by role
                    </th>
                  ) : null}
                  <th
                    scope="col"
                    className="h-[var(--row-height)] px-[var(--cell-padding-x)] text-right font-medium"
                  >
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {detail.attributes.map((a, i) => (
                  <tr key={a.id} className="hover:bg-raised">
                    <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top">
                      <div className="font-medium">
                        {a.title}
                        {a.isSystem ? (
                          <span className="ml-2 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4 text-ink-muted">
                            system
                          </span>
                        ) : null}
                      </div>
                      <div className="font-mono text-[var(--text-xs)] text-ink-muted">
                        {a.apiSlug}
                      </div>
                      {a.description ? (
                        <div className="text-[var(--text-xs)] text-ink-secondary">
                          {a.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top text-ink-secondary">
                      {TYPE_LABEL[a.type]}
                    </td>
                    <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top text-ink-secondary">
                      {[a.isRequired ? 'required' : null, a.isUnique ? 'unique' : null]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                    <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top">
                      <IndexPill state={a.indexState} progress={a.indexProgress} />
                      {edits && isIndexable(a.type) ? (
                        <div className="mt-1">
                          <ActionButton
                            size="sm"
                            variant="ghost"
                            pendingText="Working…"
                            action={setIndexedAction.bind(
                              null,
                              workspace.slug,
                              object,
                              a.id,
                              !(a.isIndexed && a.indexState !== 'FAILED'),
                            )}
                          >
                            {a.isIndexed && a.indexState !== 'FAILED'
                              ? 'Remove index'
                              : a.indexState === 'FAILED'
                                ? 'Retry index'
                                : 'Add index'}
                          </ActionButton>
                        </div>
                      ) : null}
                    </td>
                    {edits ? (
                      <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top">
                        <div className="flex flex-col gap-1">
                          {ROLES.filter((r) => r !== 'OWNER').map((r) => (
                            <div key={r} className="flex items-center gap-2 text-[var(--text-xs)]">
                              <span className="w-16 text-ink-muted">{r.toLowerCase()}</span>
                              <PermissionSelect
                                role={r}
                                current={a.permissions.find((x) => x.role === r)?.access ?? null}
                                action={setPermissionAction.bind(
                                  null,
                                  workspace.slug,
                                  object,
                                  a.id,
                                )}
                              />
                            </div>
                          ))}
                        </div>
                      </td>
                    ) : null}
                    <td className="px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-top">
                      {edits ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex gap-1">
                            <ActionButton
                              size="sm"
                              variant="ghost"
                              pendingText="…"
                              disabled={i === 0}
                              title={`Move ${a.title} up`}
                              action={reorderAttributeAction.bind(
                                null,
                                workspace.slug,
                                object,
                                detail.id,
                                orderedIds,
                                a.id,
                                'up',
                              )}
                            >
                              <span aria-hidden>↑</span>
                              <span className="sr-only">Move {a.title} up</span>
                            </ActionButton>
                            <ActionButton
                              size="sm"
                              variant="ghost"
                              pendingText="…"
                              disabled={i === detail.attributes.length - 1}
                              title={`Move ${a.title} down`}
                              action={reorderAttributeAction.bind(
                                null,
                                workspace.slug,
                                object,
                                detail.id,
                                orderedIds,
                                a.id,
                                'down',
                              )}
                            >
                              <span aria-hidden>↓</span>
                              <span className="sr-only">Move {a.title} down</span>
                            </ActionButton>
                          </div>
                          <ConfirmAction
                            label="Delete"
                            question={
                              <>
                                Delete {a.title}? Values are kept and the attribute is restorable
                                for 24 hours.
                              </>
                            }
                            confirmLabel="Delete attribute"
                            action={deleteAttributeAction.bind(null, workspace.slug, object, a.id)}
                            disabled={a.isSystem}
                            disabledReason={`${a.title} is a system attribute; identity resolution depends on it.`}
                          />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail.recentlyDeleted.length > 0 ? (
        <section aria-labelledby="deleted-heading" className="flex flex-col gap-3">
          <h3 id="deleted-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Recently deleted
          </h3>
          <p className="text-[var(--text-sm)] text-ink-secondary">
            Restorable until the time shown; after that the column is dropped for good.
          </p>
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {detail.recentlyDeleted.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[var(--text-sm)]"
              >
                <span>
                  <span className="font-medium">{d.title}</span>{' '}
                  <span className="font-mono text-ink-muted">{d.apiSlug}</span> ·{' '}
                  {TYPE_LABEL[d.type]}
                  {d.purgeAfter ? (
                    <span className="text-ink-muted">
                      {' '}
                      · until <LocalDateTime iso={d.purgeAfter.toISOString()} />
                    </span>
                  ) : null}
                </span>
                {edits ? (
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    pendingText="Restoring…"
                    action={restoreAttributeAction.bind(null, workspace.slug, object, d.id)}
                  >
                    Restore
                  </ActionButton>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="add-attribute-heading" className="flex flex-col gap-3">
        <h3
          id="add-attribute-heading"
          className="text-[var(--text-md)] font-semibold tracking-tight"
        >
          Add attribute
        </h3>
        {edits ? (
          <AttributeForm
            action={createAttributeAction.bind(null, workspace.slug, object, detail.id)}
            objectTypes={objectTypes}
            recordCount={detail.recordCount}
          />
        ) : (
          <PermissionNote>
            Only owners and admins change the schema. You are a {workspace.role.toLowerCase()}.
          </PermissionNote>
        )}
      </section>
    </div>
  );
}

function IndexPill({ state, progress }: { state: string; progress: number }) {
  switch (state) {
    case 'READY':
      return <StatusPill tone="good">indexed</StatusPill>;
    case 'BUILDING':
      return <StatusPill tone="info">building {progress}%</StatusPill>;
    case 'DROPPING':
      return <StatusPill tone="info">removing</StatusPill>;
    case 'FAILED':
      return <StatusPill tone="critical">failed</StatusPill>;
    default:
      return (
        <StatusPill tone="neutral" glyph={null}>
          none
        </StatusPill>
      );
  }
}
