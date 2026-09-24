import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/action-button';
import { BoardView } from '@/components/board/board-view';
import { ConfirmAction } from '@/components/confirm-action';
import { DataTable, Td, Th } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManageLists, canWriteRecords } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { searchRecordsAction } from '../../records/actions';
import { deleteListAction } from '../actions';
import { addEntryAction, entryHistoryAction, nudgeEntryAction, removeEntryAction } from './actions';
import { AddEntryForm, EntryHistory } from './entry-controls';

export default async function ListDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}`;

  let list;
  try {
    list = await client.list.get({ id });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND', 'BAD_REQUEST')) notFound();
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="This list is closed to your role"
          description="Reading lists needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  const writes = canWriteRecords(workspace.role);
  const manages = canManageLists(workspace.role);
  const recordHref = (recordId: string) => `${base}/records/${list.objectType.apiSlug}/${recordId}`;
  const existing = new Set(list.entries.map((e) => e.recordId));
  const search = searchRecordsAction.bind(null, workspace.slug, list.objectType.id);
  const isPipeline = list.kind === 'PIPELINE';

  const Controls = ({
    entry,
    prev,
    next,
  }: {
    entry: (typeof list.entries)[number];
    prev: (typeof list.entries)[number] | undefined;
    next: (typeof list.entries)[number] | undefined;
  }) => (
    <div className="flex flex-wrap items-center gap-1">
      <ActionButton
        action={nudgeEntryAction.bind(null, workspace.slug, list.id, entry.id)}
        hidden={{ before: prev?.id ?? '' }}
        pendingText="…"
        variant="ghost"
        disabled={!prev}
        title="Move up"
      >
        <span aria-hidden>↑</span>
        <span className="sr-only">Move {entry.label} up</span>
      </ActionButton>
      <ActionButton
        action={nudgeEntryAction.bind(null, workspace.slug, list.id, entry.id)}
        hidden={{ after: next?.id ?? '' }}
        pendingText="…"
        variant="ghost"
        disabled={!next}
        title="Move down"
      >
        <span aria-hidden>↓</span>
        <span className="sr-only">Move {entry.label} down</span>
      </ActionButton>
      <ConfirmAction
        label="Remove"
        question={<>Remove {entry.label}?</>}
        confirmLabel="Remove"
        action={removeEntryAction.bind(null, workspace.slug, list.id, entry.id)}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`${base}/lists`}>Lists</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {list.name}
            <span className="rounded-[var(--radius-pill)] border border-hairline px-2 text-[var(--text-xs)] font-normal text-ink-muted">
              {isPipeline ? 'pipeline' : 'collection'} · {list.objectType.plural.toLowerCase()}
            </span>
          </span>
        }
        description={
          <>
            <span className="tnum">{list.entries.length}</span>{' '}
            {list.entries.length === 1 ? 'entry' : 'entries'}
            {list.description ? ` · ${list.description}` : ''}
          </>
        }
        actions={
          manages ? (
            <ConfirmAction
              label="Delete list"
              size="md"
              question={<>Delete “{list.name}”? Records stay; only the list and its entries go.</>}
              confirmLabel="Delete list"
              action={deleteListAction.bind(null, workspace.slug, list.id)}
            />
          ) : undefined
        }
      />

      {!writes ? (
        <PermissionNote>
          Your role can read this list but not add, move or remove entries.
        </PermissionNote>
      ) : null}

      {list.entries.length === 0 ? (
        <EmptyState
          title={`No ${list.objectType.plural.toLowerCase()} in this list`}
          description={
            writes
              ? 'Add one below; pipelines start new entries in the first stage.'
              : 'Members can add records to it.'
          }
        />
      ) : isPipeline ? (
        <BoardView
          slug={workspace.slug}
          listId={list.id}
          objectSlug={list.objectType.apiSlug}
          canMove={writes}
        />
      ) : (
        <DataTable
          caption={`Entries in ${list.name}`}
          head={
            <>
              <Th className="w-12">#</Th>
              <Th>{list.objectType.singular}</Th>
              <Th>History</Th>
              {writes ? (
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              ) : null}
            </>
          }
        >
          {[...list.entries]
            .sort((a, b) => a.position - b.position)
            .map((entry, i, all) => (
              <tr key={entry.id} className="hover:bg-raised">
                <Td className="tnum text-ink-muted">{i + 1}</Td>
                <Td>
                  <Link
                    href={recordHref(entry.recordId)}
                    className="font-medium text-link underline-offset-2 hover:underline"
                  >
                    {entry.label}
                  </Link>
                </Td>
                <Td>
                  <EntryHistory
                    load={entryHistoryAction.bind(null, workspace.slug, entry.id)}
                    stages={list.stages}
                  />
                </Td>
                {writes ? (
                  <Td align="right">
                    <div className="flex justify-end">
                      <Controls entry={entry} prev={all[i - 1]} next={all[i + 1]} />
                    </div>
                  </Td>
                ) : null}
              </tr>
            ))}
        </DataTable>
      )}

      {writes ? (
        <section aria-labelledby="add-entry-heading" className="flex flex-col gap-3">
          <h2 id="add-entry-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Add a {list.objectType.singular.toLowerCase()}
          </h2>
          <AddEntryForm
            action={addEntryAction.bind(null, workspace.slug, list.id)}
            search={search}
            stages={isPipeline ? list.stages : []}
            objectLabel={list.objectType.singular}
            existing={existing}
          />
        </section>
      ) : null}
    </div>
  );
}
