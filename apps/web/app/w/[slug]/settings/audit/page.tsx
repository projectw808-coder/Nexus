import Link from 'next/link';
import { buttonClass, LinkButton } from '@/components/button';
import { DataTable, Td, Th } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { CONTROL_CLASS } from '@/components/field';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { describeError, isCode } from '@/lib/errors';
import { formatDateTime, isoOf } from '@/lib/format';
import { getWorkspace } from '@/lib/workspace';

const KNOWN_ACTIONS = [
  'workspace.created',
  'workspace.updated',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'invitation.created',
  'invitation.revoked',
  'invitation.accepted',
];

const TARGET_TYPES = ['Workspace', 'Membership', 'Invitation'];

const PAGE_SIZE = 50;

type Search = { cursor?: string; action?: string; targetType?: string };

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
}

function query(base: string, s: Search): string {
  const p = new URLSearchParams();
  if (s.action) p.set('action', s.action);
  if (s.targetType) p.set('targetType', s.targetType);
  if (s.cursor) p.set('cursor', s.cursor);
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

function DiffCell({ diff }: { diff: unknown }) {
  const empty = diff == null || (typeof diff === 'object' && Object.keys(diff).length === 0);
  if (empty) return <span className="text-ink-muted">—</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer text-link underline-offset-2 hover:underline">
        <span className="group-open:hidden">Show</span>
        <span className="hidden group-open:inline">Hide</span>
      </summary>
      <pre className="mt-1 max-w-xl overflow-x-auto rounded-[var(--radius-control)] border border-hairline bg-raised p-2 font-mono text-[var(--text-xs)] leading-relaxed">
        {JSON.stringify(diff, null, 2)}
      </pre>
    </details>
  );
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspace(slug);
  const filters: Search = {
    action: first(sp.action),
    targetType: first(sp.targetType),
    cursor: first(sp.cursor),
  };
  const base = `/w/${workspace.slug}/settings/audit`;
  const client = await api(workspace.slug);

  let page;
  try {
    page = await client.audit.list({
      limit: PAGE_SIZE,
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.targetType ? { targetType: filters.targetType } : {}),
    });
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="The audit log is closed to your role"
          description="Every change in the workspace is recorded here. Managers, admins and owners can read it."
          currentRole={workspace.role}
          requiredRole="MANAGER"
        />
      );
    }
    if (isCode(e, 'BAD_REQUEST')) {
      const { message } = describeError(e);
      return (
        <ErrorState
          title="That page could not be loaded"
          message={message}
          remediation="The cursor or filter in the address is not valid."
          action={
            <LinkButton href={base} variant="primary">
              Start from the latest entries
            </LinkButton>
          }
        />
      );
    }
    throw e;
  }

  const filtered = !!(filters.action || filters.targetType);

  return (
    <div className="flex flex-col gap-4">
      <form
        method="get"
        action={base}
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter the audit log"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-action" className="text-[var(--text-sm)] font-medium">
            Action
          </label>
          <input
            id="filter-action"
            name="action"
            list="audit-actions"
            defaultValue={filters.action ?? ''}
            placeholder="any"
            className={`${CONTROL_CLASS} w-56 font-mono text-[var(--text-sm)]`}
          />
          <datalist id="audit-actions">
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-target" className="text-[var(--text-sm)] font-medium">
            Target
          </label>
          <select
            id="filter-target"
            name="targetType"
            defaultValue={filters.targetType ?? ''}
            className={`${CONTROL_CLASS} w-44`}
          >
            <option value="">any</option>
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>
          Apply
        </button>
        {filtered || filters.cursor ? (
          <Link href={base} className={buttonClass('ghost')}>
            Clear
          </Link>
        ) : null}
      </form>

      {page.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'Nothing matches these filters' : 'No activity yet'}
          description={
            filtered
              ? 'Try a broader action or target, or clear the filters.'
              : 'Every mutation in the workspace writes a row here. Creating the workspace was the first.'
          }
          action={
            filtered ? (
              <LinkButton href={base} variant="secondary">
                Clear filters
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <>
          <DataTable
            caption="Audit log entries, newest first"
            head={
              <>
                <Th>Time</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Diff</Th>
              </>
            }
          >
            {page.items.map((r) => (
              <tr key={r.id} className="align-top hover:bg-raised">
                <Td className="tnum whitespace-nowrap text-ink-secondary">
                  <time dateTime={isoOf(r.at)}>{formatDateTime(r.at)}</time>
                </Td>
                <Td>
                  <span className="font-medium">{r.actor}</span>
                  {r.actorType !== 'USER' ? (
                    <span className="ml-2 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[var(--text-xs)] text-ink-muted">
                      {r.actorType.toLowerCase()}
                    </span>
                  ) : null}
                </Td>
                <Td className="font-mono text-[var(--text-xs)]">{r.action}</Td>
                <Td>
                  <span>{r.targetType}</span>
                  <span
                    className="ml-2 font-mono text-[var(--text-xs)] text-ink-muted"
                    title={r.targetId}
                  >
                    {r.targetId.slice(0, 8)}
                  </span>
                </Td>
                <Td>
                  <DiffCell diff={r.diff} />
                </Td>
              </tr>
            ))}
          </DataTable>
          <div className="flex items-center justify-between text-[var(--text-sm)] text-ink-muted">
            <span className="tnum">
              {page.items.length} {page.items.length === 1 ? 'entry' : 'entries'}
              {filters.cursor ? ' on this page' : ''}
            </span>
            {page.nextCursor ? (
              <Link
                href={query(base, { ...filters, cursor: page.nextCursor })}
                className={buttonClass('secondary')}
              >
                Load more
              </Link>
            ) : (
              <span>End of log</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
