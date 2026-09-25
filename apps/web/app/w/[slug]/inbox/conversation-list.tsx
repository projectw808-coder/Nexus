'use client';

/**
 * The list pane (§12.2.A): platform tabs with counts, filters (assignee / status / SLA /
 * unread / kind / tag), grouping by platform or person, saved views, bulk select, and a
 * virtualized cursor-paged list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { platformName, platformShort } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import {
  filtersFromJson,
  kindShort,
  memberName,
  relative,
  slaState,
  snoozePresets,
  whoIs,
  type Filters,
  type InboxViewRow,
  type ListItem,
  type Member,
} from './inbox-shared';

const ROW = 76;
const HEADER = 28;

type Row =
  { kind: 'header'; key: string; label: string } | { kind: 'item'; key: string; item: ListItem };

export function ConversationList({
  slug,
  items,
  counts,
  filters,
  setFilters,
  platforms,
  members,
  selectedId,
  onSelect,
  selection,
  setSelection,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  isPending,
  canTriage,
  views,
  onBulkDone,
  listRef,
}: {
  slug: string;
  items: ListItem[];
  counts: {
    total: number;
    byPlatform: Record<string, number>;
    unread: number;
    breached: number;
  } | null;
  filters: Filters;
  setFilters: (f: Filters) => void;
  platforms: string[];
  members: Member[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  selection: Set<string>;
  setSelection: (s: Set<string>) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  isPending: boolean;
  canTriage: boolean;
  views: InboxViewRow[];
  onBulkDone: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const now = Date.now();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewName, setViewName] = useState('');
  const [savingView, setSavingView] = useState(false);
  const createView = useMutation(
    trpc.view.create.mutationOptions({
      onSuccess: () => {
        setSavingView(false);
        setViewName('');
        void qc.invalidateQueries({ queryKey: trpc.view.list.pathKey() });
      },
    }),
  );
  const deleteView = useMutation(
    trpc.view.delete.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.view.list.pathKey() }),
    }),
  );
  const bulk = useMutation(
    trpc.conversation.bulk.mutationOptions({
      onSuccess: () => {
        setSelection(new Set());
        onBulkDone();
      },
    }),
  );
  const tags = useQuery({
    ...trpc.conversation.list.queryOptions({ status: filters.status, limit: 1 }),
    enabled: false,
  });
  void tags;

  const rows = useMemo<Row[]>(() => {
    if (filters.groupBy === 'none')
      return items.map((item) => ({ kind: 'item', key: item.id, item }));
    const groups = new Map<string, ListItem[]>();
    for (const item of items) {
      const label = filters.groupBy === 'platform' ? platformName(item.platform) : whoIs(item);
      const arr = groups.get(label);
      if (arr) arr.push(item);
      else groups.set(label, [item]);
    }
    const out: Row[] = [];
    for (const [label, arr] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({ kind: 'header', key: `h:${label}`, label: `${label} (${arr.length})` });
      for (const item of arr) out.push({ kind: 'item', key: item.id, item });
    }
    return out;
  }, [items, filters.groupBy]);

  const virtualizer = useVirtualizer({
    count: rows.length + (hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER : ROW),
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtual = virtualItems[virtualItems.length - 1];
  if (lastVirtual && lastVirtual.index >= rows.length && hasNextPage && !isFetchingNextPage)
    fetchNextPage();

  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const toggleSelect = (id: string, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(id);
    else next.delete(id);
    setSelection(next);
  };
  const allSelected = items.length > 0 && items.every((i) => selection.has(i.id));

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="conversation-list">
      {/* Platform tabs */}
      <div
        role="tablist"
        aria-label="Platforms"
        className="flex flex-wrap items-center gap-1 border-b border-hairline pb-2"
      >
        <Tab
          active={!filters.platform}
          onClick={() => set({ platform: undefined })}
          label="All"
          count={counts?.total ?? null}
        />
        {platforms.map((p) => (
          <Tab
            key={p}
            active={filters.platform === p}
            onClick={() => set({ platform: filters.platform === p ? undefined : p })}
            label={platformName(p)}
            count={counts?.byPlatform[p] ?? 0}
          />
        ))}
      </div>

      {/* Filters */}
      <div
        className="flex flex-wrap items-center gap-1.5 text-[var(--text-xs)]"
        role="group"
        aria-label="Filters"
      >
        <select
          aria-label="Status"
          value={filters.status}
          onChange={(e) => set({ status: e.target.value as Filters['status'] })}
          className={selectClass}
        >
          <option value="OPEN">Open</option>
          <option value="SNOOZED">Snoozed</option>
          <option value="CLOSED">Closed</option>
          <option value="SPAM">Spam</option>
        </select>
        <select
          aria-label="Assignee"
          value={filters.assignee}
          onChange={(e) => set({ assignee: e.target.value })}
          className={selectClass}
        >
          <option value="anyone">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {memberName(m)}
            </option>
          ))}
        </select>
        <select
          aria-label="SLA"
          value={filters.sla ?? ''}
          onChange={(e) => set({ sla: (e.target.value || undefined) as Filters['sla'] })}
          className={selectClass}
        >
          <option value="">Any SLA</option>
          <option value="breached">
            Breached{counts?.breached ? ` (${counts.breached})` : ''}
          </option>
          <option value="due_soon">Due soon</option>
        </select>
        <select
          aria-label="Kind"
          value={filters.kind ?? ''}
          onChange={(e) => set({ kind: (e.target.value || undefined) as Filters['kind'] })}
          className={selectClass}
        >
          <option value="">All kinds</option>
          <option value="DM">DMs</option>
          <option value="COMMENT_THREAD">Comments</option>
          <option value="MENTION">Mentions</option>
          <option value="REVIEW">Reviews</option>
        </select>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={filters.unread}
            onChange={(e) => set({ unread: e.target.checked })}
          />
          Unread{counts?.unread ? ` (${counts.unread})` : ''}
        </label>
        <select
          aria-label="Group by"
          value={filters.groupBy}
          onChange={(e) => set({ groupBy: e.target.value as Filters['groupBy'] })}
          className={selectClass}
        >
          <option value="none">No grouping</option>
          <option value="platform">Group by platform</option>
          <option value="person">Group by person</option>
        </select>
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search…"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          className="h-7 min-w-0 flex-1 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-xs)] text-ink"
        />
        {filters.tag ? (
          <button
            type="button"
            className="rounded-[var(--radius-pill)] border border-strong px-2 py-0.5"
            onClick={() => set({ tag: undefined })}
          >
            #{filters.tag} ×
          </button>
        ) : null}
      </div>

      {/* Saved views */}
      <div
        className="flex flex-wrap items-center gap-1 text-[var(--text-xs)]"
        aria-label="Saved views"
      >
        {views.map((v) => (
          <span
            key={v.id}
            className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-hairline px-2 py-0.5"
          >
            <button
              type="button"
              onClick={() => setFilters(filtersFromJson(v.filters))}
              className="hover:underline"
            >
              {v.name}
              {v.isShared ? '' : ' (mine)'}
            </button>
            {v.isMine ? (
              <button
                type="button"
                aria-label={`Delete view ${v.name}`}
                onClick={() => deleteView.mutate({ id: v.id })}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:text-ink"
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        {savingView ? (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!viewName.trim()) return;
              createView.mutate({
                scope: 'inbox',
                name: viewName.trim(),
                filters: { ...filters },
                isShared: false,
                layout: 'TABLE',
                columns: [],
                sorts: [],
              });
            }}
          >
            <input
              aria-label="View name"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="View name"
              className="h-6 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-ink"
            />
            <Button type="submit" size="sm" variant="primary" disabled={createView.isPending}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSavingView(false)}>
              Cancel
            </Button>
            {createView.isError ? (
              <span role="alert" className="text-critical">
                {createView.error.message}
              </span>
            ) : null}
          </form>
        ) : (
          <button
            type="button"
            className="text-link underline-offset-2 hover:underline"
            onClick={() => setSavingView(true)}
          >
            Save current filters as a view
          </button>
        )}
      </div>

      {/* Bulk bar */}
      {canTriage && selection.size > 0 ? (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-card)] border border-strong bg-raised px-2 py-1.5 text-[var(--text-xs)]"
        >
          <span className="tnum font-medium">{selection.size} selected</span>
          <select
            aria-label="Assign selected"
            className={selectClass}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value === '') return;
              bulk.mutate({
                ids: [...selection],
                action: {
                  type: 'assign',
                  userId: e.target.value === 'none' ? null : e.target.value,
                },
              });
              e.target.value = '';
            }}
          >
            <option value="">Assign…</option>
            <option value="none">Unassign</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {memberName(m)}
              </option>
            ))}
          </select>
          <select
            aria-label="Snooze selected"
            className={selectClass}
            defaultValue=""
            onChange={(e) => {
              const p = snoozePresets().find((x) => x.label === e.target.value);
              if (p)
                bulk.mutate({ ids: [...selection], action: { type: 'snooze', until: p.until } });
              e.target.value = '';
            }}
          >
            <option value="">Snooze…</option>
            {snoozePresets().map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() =>
              bulk.mutate({ ids: [...selection], action: { type: 'status', status: 'CLOSED' } })
            }
            disabled={bulk.isPending}
          >
            Close
          </Button>
          <Button
            size="sm"
            onClick={() =>
              bulk.mutate({ ids: [...selection], action: { type: 'status', status: 'OPEN' } })
            }
            disabled={bulk.isPending}
          >
            Reopen
          </Button>
          <Button
            size="sm"
            onClick={() => bulk.mutate({ ids: [...selection], action: { type: 'read' } })}
            disabled={bulk.isPending}
          >
            Mark read
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              bulk.mutate({ ids: [...selection], action: { type: 'status', status: 'SPAM' } })
            }
            disabled={bulk.isPending}
          >
            Spam
          </Button>
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem('tag') as HTMLInputElement;
              const t = input.value.trim();
              if (t)
                bulk.mutate({ ids: [...selection], action: { type: 'tag', add: [t], remove: [] } });
              input.value = '';
            }}
          >
            <input
              name="tag"
              aria-label="Add tag to selected"
              placeholder="Add tag"
              className="h-6 w-24 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-ink"
            />
          </form>
          <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>
            Clear
          </Button>
          {bulk.isError ? (
            <span role="alert" className="text-critical">
              {bulk.error.message}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* The list */}
      {isPending ? (
        <p className="text-[var(--text-sm)] text-ink-muted">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          title={
            filters.status === 'OPEN' &&
            !filters.platform &&
            filters.assignee === 'anyone' &&
            !filters.search &&
            !filters.unread &&
            !filters.sla
              ? 'Inbox zero'
              : 'Nothing matches'
          }
          description={
            filters.status === 'OPEN'
              ? 'New messages, comments and mentions appear here the moment they arrive.'
              : 'Adjust the filters to see other threads.'
          }
        />
      ) : (
        <div className="flex items-center gap-2 px-1 text-[var(--text-xs)] text-ink-muted">
          {canTriage ? (
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                aria-label="Select all loaded"
                checked={allSelected}
                onChange={(e) =>
                  setSelection(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                }
              />
              all
            </label>
          ) : null}
          <span className="tnum">
            {items.length}
            {counts ? ` of ${counts.total}` : ''} loaded
          </span>
        </div>
      )}
      <div
        ref={(el) => {
          scrollRef.current = el;
          listRef.current = el;
        }}
        role="list"
        aria-label="Conversations"
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-hairline bg-card outline-none focus-visible:shadow-[var(--focus-ring)]"
        style={{ maxHeight: 'calc(100vh - 20rem)' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            const style = {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
              height: vi.size,
            };
            if (!row)
              return (
                <div
                  key="more"
                  style={style}
                  className="flex items-center justify-center text-[var(--text-xs)] text-ink-muted"
                >
                  {isFetchingNextPage ? 'Loading more…' : ''}
                </div>
              );
            if (row.kind === 'header')
              return (
                <div
                  key={row.key}
                  style={style}
                  className="flex items-center bg-raised px-3 text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
                >
                  {row.label}
                </div>
              );
            const c = row.item;
            const sla = slaState(c.slaDueAt, now);
            const selected = c.id === selectedId;
            return (
              <div
                key={row.key}
                style={style}
                id={`conv-${c.id}`}
                role="listitem"
                data-testid="conversation-row"
                className={`flex items-stretch border-b border-hairline ${selected ? 'bg-raised' : 'hover:bg-raised'}`}
              >
                {canTriage ? (
                  <label className="flex items-start px-2 pt-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${whoIs(c)}`}
                      checked={selection.has(c.id)}
                      onChange={(e) => toggleSelect(c.id, e.target.checked)}
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(c.id)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-2 text-left"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-sm)] font-medium">
                      {c.unreadCount > 0 ? (
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full bg-link"
                          aria-label={`${c.unreadCount} unread`}
                        />
                      ) : null}
                      <span className="truncate">{whoIs(c)}</span>
                    </span>
                    <span className="shrink-0 text-[var(--text-xs)] text-ink-muted">
                      {relative(c.lastMessageAt, now)}
                    </span>
                  </span>
                  <span className="truncate text-[var(--text-xs)] text-ink-secondary">
                    {c.lastMessage
                      ? `${c.lastMessage.direction === 'OUTBOUND' ? 'You: ' : ''}${c.lastMessage.body}`
                      : (c.subject ?? '')}
                  </span>
                  <span className="flex flex-wrap items-center gap-1 text-[10px] leading-4 text-ink-muted">
                    <span
                      className="rounded-[var(--radius-pill)] border border-hairline px-1.5"
                      title={c.connection.label}
                    >
                      {platformShort(c.platform)} · {kindShort(c.kind)}
                    </span>
                    {c.assignee ? (
                      <span className="rounded-[var(--radius-pill)] bg-raised px-1.5">
                        {memberName(c.assignee)}
                      </span>
                    ) : null}
                    {sla.tone !== 'none' ? (
                      <span
                        className={`rounded-[var(--radius-pill)] px-1.5 ${sla.tone === 'breached' ? 'border border-critical font-medium text-critical' : sla.tone === 'soon' ? 'border border-hairline font-medium text-warning' : 'border border-hairline'}`}
                      >
                        {sla.tone === 'breached' ? '! ' : sla.tone === 'soon' ? '△ ' : ''}
                        {sla.label}
                      </span>
                    ) : null}
                    {c.status === 'SNOOZED' && c.snoozedUntil ? (
                      <span className="rounded-[var(--radius-pill)] border border-hairline px-1.5">
                        zz {relative(c.snoozedUntil, now)}
                      </span>
                    ) : null}
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-[var(--radius-pill)] border border-hairline px-1.5"
                      >
                        #{t}
                      </span>
                    ))}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {slug}
      </p>
    </div>
  );
}

const selectClass =
  'h-7 rounded-[var(--radius-control)] border border-hairline bg-raised px-1.5 text-[var(--text-xs)] text-ink';

function Tab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-2 text-[var(--text-xs)] ${active ? 'bg-ink text-ink-inverse' : 'text-ink-secondary hover:bg-raised hover:text-ink'}`}
    >
      {label}
      {count !== null ? <span className="tnum opacity-80">{count}</span> : null}
    </button>
  );
}
