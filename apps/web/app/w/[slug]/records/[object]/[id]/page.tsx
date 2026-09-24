import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/action-button';
import { AttributePanel } from '@/components/record/attribute-panel';
import { NotesPanel } from '@/components/record/notes-panel';
import { TasksPanel } from '@/components/record/tasks-panel';
import { LinkButton } from '@/components/button';
import { ConfirmAction } from '@/components/confirm-action';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { StatusPill } from '@/components/status-pill';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { isoOf } from '@/lib/format';
import { canDeleteRecords, canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { deleteRecordAction, restoreRecordAction } from '../actions';

export default async function RecordDetailPage({
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
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="This record is closed to your role"
          description="Reading records needs a role that can see this object."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  if (rec.objectType.apiSlug !== object) notFound();

  const objectTypes = await client.objectType.list();
  const objectSlugById = Object.fromEntries(objectTypes.map((o) => [o.id, o.apiSlug]));
  const attrs = [...rec.attributes].sort((a, b) => a.position - b.position);
  const deleted = rec.deletedAt !== null;
  const writes = canWriteRecords(workspace.role) && !deleted;
  const deletes = canDeleteRecords(workspace.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <>
            <Link href={`/w/${workspace.slug}/records`}>Records</Link> /{' '}
            <Link href={base}>{rec.objectType.plural}</Link>
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {rec.label}
            {deleted ? <StatusPill tone="warning">Deleted</StatusPill> : null}
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-4 text-[var(--text-sm)]">
            <span>
              Created <LocalDateTime iso={isoOf(rec.createdAt) ?? ''} />
            </span>
            <span>
              Updated <LocalDateTime iso={isoOf(rec.updatedAt) ?? ''} />
            </span>
            <span className="font-mono text-[var(--text-xs)] text-ink-muted">{rec.id}</span>
          </span>
        }
        actions={
          <>
            {writes ? (
              <LinkButton href={`${base}/${rec.id}/edit`} variant="primary">
                Edit
              </LinkButton>
            ) : null}
            {deletes && !deleted ? (
              <ConfirmAction
                label="Delete"
                size="md"
                question={<>Delete {rec.label}? It can be restored afterwards.</>}
                confirmLabel="Delete record"
                action={deleteRecordAction.bind(null, workspace.slug, object, rec.id)}
              />
            ) : null}
          </>
        }
      />

      {deleted ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-hairline bg-card px-4 py-3"
          style={{ borderColor: 'var(--status-warning)' }}
        >
          <p className="text-[var(--text-sm)] text-ink-secondary">
            <span aria-hidden>△ </span>This {rec.objectType.singular.toLowerCase()} was deleted
            {rec.deletedAt ? (
              <>
                {' '}
                on <LocalDateTime iso={isoOf(rec.deletedAt) ?? ''} />
              </>
            ) : null}
            . It is hidden from tables, lists and search until it is restored.
          </p>
          {deletes ? (
            <ActionButton
              action={restoreRecordAction.bind(null, workspace.slug, object, rec.id)}
              pendingText="Restoring…"
              variant="primary"
              size="md"
            >
              Restore
            </ActionButton>
          ) : (
            <span className="text-[var(--text-sm)] text-ink-muted">
              Managers, admins and owners can restore it.
            </span>
          )}
        </div>
      ) : null}

      {!writes && !deleted ? (
        <PermissionNote>Your role can read this record but not change it.</PermissionNote>
      ) : null}

      <section aria-labelledby="values-heading" className="flex flex-col gap-3">
        <h2 id="values-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Attributes
        </h2>
        {attrs.length === 0 ? (
          <EmptyState
            compact
            title="No visible attributes"
            description="Every attribute of this object is hidden from your role."
          />
        ) : (
          <AttributePanel
            slug={workspace.slug}
            recordId={rec.id}
            attributes={attrs}
            initialValues={rec.values}
            canEdit={writes}
          />
        )}
      </section>

      <section aria-labelledby="relations-heading" className="flex flex-col gap-3">
        <h2 id="relations-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Relations{' '}
          <span className="tnum font-normal text-ink-muted">({rec.relations.length})</span>
        </h2>
        {rec.relations.length === 0 ? (
          <EmptyState
            compact
            title="No relations"
            description="Relationship attributes link this record to others; links in both directions appear here."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {rec.relations.map((rel, i) => {
              const otherSlug = objectSlugById[rel.other.objectTypeId];
              const otherType = objectTypes.find((o) => o.id === rel.other.objectTypeId);
              return (
                <li
                  key={`${rel.attribute.id}:${rel.other.id}:${i}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[var(--text-sm)]"
                >
                  <span className="text-ink-muted">{rel.direction === 'out' ? '→' : '←'}</span>
                  <span className="font-medium">{rel.attribute.title}</span>
                  <span className="text-ink-muted">{otherType?.singular ?? 'record'}</span>
                  {otherSlug ? (
                    <Link
                      href={`/w/${workspace.slug}/records/${otherSlug}/${rel.other.id}`}
                      className="font-mono text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                    >
                      {rel.other.id}
                    </Link>
                  ) : (
                    <span className="font-mono text-[var(--text-xs)]">{rel.other.id}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="lists-heading" className="flex flex-col gap-3">
        <h2 id="lists-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Lists <span className="tnum font-normal text-ink-muted">({rec.lists.length})</span>
        </h2>
        {rec.lists.length === 0 ? (
          <EmptyState
            compact
            title="Not in any list"
            description="Pipelines and collections group records; add this one from a list's page."
            action={
              <LinkButton href={`/w/${workspace.slug}/lists`} variant="secondary" size="sm">
                Browse lists
              </LinkButton>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {rec.lists.map((l) => (
              <li
                key={l.entryId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[var(--text-sm)]"
              >
                <Link
                  href={`/w/${workspace.slug}/lists/${l.listId}`}
                  className="font-medium text-link underline-offset-2 hover:underline"
                >
                  {l.name}
                </Link>
                <span className="rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[var(--text-xs)] text-ink-muted">
                  {l.kind.toLowerCase()}
                </span>
                {l.stage ? <span className="text-ink-secondary">Stage: {l.stage}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <NotesPanel recordId={rec.id} canWrite={writes} />
        <TasksPanel recordId={rec.id} canWrite={writes} />
      </div>

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
        <h2 id="timeline-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Timeline
        </h2>
        <EmptyState
          compact
          title="No channel activity yet"
          description="Messages, comments, mentions and attribution land here once platforms are connected (Phase 6)."
        />
      </section>
    </div>
  );
}
