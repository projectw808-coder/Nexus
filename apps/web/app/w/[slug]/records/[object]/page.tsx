import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClass, LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { ErrorState, InlineNotice } from '@/components/error-state';
import { CONTROL_CLASS } from '@/components/field';
import { DataGrid } from '@/components/data-grid/data-grid';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { describeError, isCode } from '@/lib/errors';
import {
  filterParam,
  parseTableQuery,
  tableHref,
  tableQueryFromView,
  toRecordQuery,
  withoutCursor,
  type SearchParams,
} from '@/lib/record-query';
import {
  canDeleteRecords,
  canEditSchema,
  canExport,
  canImport,
  canWriteRecords,
} from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { saveViewAction } from './actions';
import { FilterBuilder } from './filter-builder';
import { SavedViews, type ViewOption } from './saved-views';

const PAGE_SIZE = 50;
/** Phase 3 brings the real table; until then the first columns by position are shown. */

export default async function RecordsTablePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; object: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug, object }, sp] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const base = `/w/${workspace.slug}/records/${object}`;
  const table = parseTableQuery(sp);

  let attrs;
  try {
    attrs = await client.attribute.list({ objectType: object });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Records are closed to your role"
          description="Reading records needs a role that can see this object."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  const query = toRecordQuery(table, attrs, PAGE_SIZE);
  let page;
  try {
    page = await client.record.query({ objectType: object, query });
  } catch (e) {
    if (isCode(e, 'NOT_FOUND')) notFound();
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Records are closed to your role"
          description="Reading records needs a role that can see this object."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    if (isCode(e, 'BAD_REQUEST')) {
      const { message } = describeError(e);
      return (
        <ErrorState
          title="That view could not be loaded"
          message={message}
          remediation="A filter, sort or cursor in the address is not valid for this object."
          action={
            <LinkButton href={base} variant="primary">
              Start over
            </LinkButton>
          }
        />
      );
    }
    throw e;
  }

  const views = await client.view.list({ objectTypeId: page.objectType.id }).catch((e: unknown) => {
    if (isCode(e, 'FORBIDDEN')) return [];
    throw e;
  });

  const ot = page.objectType;
  const visible = [...page.attributes].sort((a, b) => a.position - b.position);
  const lists = await client.list.list({ objectType: object });
  const filtered = table.filters.length > 0 || !!table.q;
  const writes = canWriteRecords(workspace.role);
  const imports = canImport(workspace.role);
  const exports = canExport(workspace.role);
  const deletedId = typeof sp['deleted'] === 'string' ? sp['deleted'] : undefined;

  const viewOptions: ViewOption[] = views.map((v) => ({
    id: v.id,
    name: v.name,
    isShared: v.isShared,
    isMine: v.isMine,
    href: tableHref(base, tableQueryFromView(v.filters, v.sorts, attrs)),
  }));
  const currentHref = tableHref(base, withoutCursor({ ...table, q: undefined }));
  const exportHref = (format: 'csv' | 'json') =>
    tableHref(`${base}/export`, withoutCursor(table), { format });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={<Link href={`/w/${workspace.slug}/records`}>Records</Link>}
        title={ot.plural}
        description={
          <>
            <span className="tnum">{page.total.toLocaleString('en-US')}</span>{' '}
            {page.total === 1 ? 'record' : 'records'}
            {filtered ? ' match' : ''}
            {ot.description ? ` · ${ot.description}` : ''}
          </>
        }
        actions={
          <>
            {canEditSchema(workspace.role) ? (
              <LinkButton
                href={`/w/${workspace.slug}/settings/objects/${ot.apiSlug}`}
                variant="ghost"
              >
                Attributes
              </LinkButton>
            ) : null}
            {imports ? (
              <LinkButton href={`${base}/import`} variant="secondary">
                Import CSV
              </LinkButton>
            ) : null}
            {writes ? (
              <LinkButton href={`${base}/new`} variant="primary">
                New {ot.singular.toLowerCase()}
              </LinkButton>
            ) : null}
          </>
        }
      />

      {deletedId ? (
        <InlineNotice tone="good">
          Record deleted. It can be restored from its page:{' '}
          <Link
            href={`${base}/${deletedId}`}
            className="text-link underline-offset-2 hover:underline"
          >
            restore
          </Link>
          .
        </InlineNotice>
      ) : null}

      {!writes ? (
        <PermissionNote>
          Your role is read-only here: you can search, filter and export, but not change records.
        </PermissionNote>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form
          method="get"
          action={base}
          role="search"
          className="flex items-center gap-2"
          aria-label={`Search ${ot.plural.toLowerCase()}`}
        >
          {table.filters.map((f) => (
            <input key={filterParam(f)} type="hidden" name="f" value={filterParam(f)} />
          ))}
          {table.sort ? (
            <>
              <input type="hidden" name="sort" value={table.sort} />
              <input type="hidden" name="dir" value={table.dir} />
            </>
          ) : null}
          <label htmlFor="records-q" className="sr-only">
            Search
          </label>
          <input
            id="records-q"
            name="q"
            type="search"
            defaultValue={table.q ?? ''}
            placeholder={`Search ${ot.plural.toLowerCase()}…`}
            maxLength={200}
            className={`${CONTROL_CLASS} w-64`}
          />
          <button type="submit" className={buttonClass('secondary')}>
            Search
          </button>
          {filtered || table.sort || table.cursor ? (
            <Link href={base} className={buttonClass('ghost')}>
              Clear
            </Link>
          ) : null}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <SavedViews
            views={viewOptions}
            currentHref={currentHref}
            baseHref={base}
            filtersJson={JSON.stringify(query.filters)}
            sortsJson={JSON.stringify(query.sort)}
            canShare={canEditSchema(workspace.role)}
            canSave={writes}
            saveAction={saveViewAction.bind(null, workspace.slug, object, ot.id)}
          />
          {exports ? (
            <>
              <a href={exportHref('csv')} className={buttonClass('secondary')} download>
                Export CSV
              </a>
              <a href={exportHref('json')} className={buttonClass('secondary')} download>
                Export JSON
              </a>
            </>
          ) : null}
        </div>
      </div>

      <FilterBuilder base={base} query={table} attributes={visible} />

      {page.items.length === 0 ? (
        filtered ? (
          <EmptyState
            title={`No ${ot.plural.toLowerCase()} match`}
            description="Try a broader search, remove a filter, or clear everything."
            action={
              <LinkButton href={base} variant="secondary">
                Clear filters
              </LinkButton>
            }
          />
        ) : (
          <EmptyState
            title={`Add your first ${ot.singular.toLowerCase()}`}
            description={
              writes
                ? `${ot.plural} you create or import appear here. Every column is an attribute; admins shape them under Settings → Objects.`
                : `No ${ot.plural.toLowerCase()} yet. Members can add records; you can search and export once there are some.`
            }
            action={
              writes ? (
                <>
                  <LinkButton href={`${base}/new`} variant="primary">
                    New {ot.singular.toLowerCase()}
                  </LinkButton>
                  {imports ? (
                    <LinkButton href={`${base}/import`} variant="secondary">
                      Import CSV
                    </LinkButton>
                  ) : null}
                </>
              ) : undefined
            }
          />
        )
      ) : (
        <DataGrid
          slug={workspace.slug}
          objectType={{ id: ot.id, apiSlug: ot.apiSlug, singular: ot.singular, plural: ot.plural }}
          attributes={visible}
          lists={lists.map((l) => ({ id: l.id, name: l.name, kind: l.kind }))}
          filters={query.filters}
          initialSort={query.sort}
          search={query.search}
          canEdit={writes}
          canDelete={canDeleteRecords(workspace.role)}
        />
      )}
    </div>
  );
}
