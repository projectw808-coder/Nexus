'use client';

/**
 * The records table (§12.2.D): TanStack Table for column state, TanStack Virtual for rows,
 * TanStack Query for cursor pages. Columns resize, reorder, pin, hide and group; cells edit
 * inline; the footer aggregates; rows select for bulk actions. Everything a mouse can do has a
 * keyboard route: arrow keys move an active cell (roving tabindex), Enter edits or opens the
 * column menu, Space selects, Escape cancels. Sorting, filtering and search are server-side;
 * grouping and aggregates run over the rows loaded so far and say so.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ExpandedState,
  type RowData,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filter, Sort } from '@nexus/core';
import { toCsv } from '@nexus/core';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { TableSkeleton } from '@/components/skeleton';
import { ValueCell } from '@/components/value-cell';
import {
  formatCurrency,
  formatNumber,
  currencyOf,
  isSortable,
  optionLabel,
  type AttributeLike,
  type ObjectTypeRef,
} from '@/lib/attributes';
import { useTRPC, useTRPCClient } from '@/lib/trpc-client';
import { BulkBar, type ListOption } from './bulk-bar';
import { CellEditor, isInlineEditable } from './cell-editor';
import { ColumnMenu, type ColumnMenuAction, type ColumnMenuItem } from './column-menu';
import { EMPTY_LAYOUT, defaultWidth, loadLayout, saveLayout, type GridLayout } from './grid-state';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- augmentation must match the library signature
  interface ColumnMeta<TData extends RowData, TValue> {
    attr?: AttributeLike;
  }
}

export type GridRow = {
  id: string;
  label: string;
  values: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type Props = {
  slug: string;
  objectType: ObjectTypeRef;
  attributes: AttributeLike[];
  lists: ListOption[];
  filters: Filter[];
  search: string | undefined;
  initialSort: Sort[];
  canEdit: boolean;
  canDelete: boolean;
  pageSize?: number;
};

const ROW_HEIGHT = 36;
const GROUPABLE = new Set(['SELECT', 'STATUS', 'BOOLEAN']);
const NUMERIC = new Set(['NUMBER', 'CURRENCY', 'RATING']);

const helper = createColumnHelper<GridRow>();

export function DataGrid(props: Props) {
  const { slug, objectType, attributes, lists, filters, search, canEdit, canDelete } = props;
  const pageSize = props.pageSize ?? 200;
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const router = useRouter();

  // ── layout state (per viewer) ──────────────────────────────────────────────
  const [layout, setLayout] = useState<GridLayout>(EMPTY_LAYOUT);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  useEffect(() => {
    setLayout(loadLayout(objectType.id));
    setLayoutLoaded(true);
  }, [objectType.id]);
  useEffect(() => {
    if (layoutLoaded) saveLayout(objectType.id, layout);
  }, [layout, layoutLoaded, objectType.id]);
  const patchLayout = useCallback(
    (p: Partial<GridLayout>) => setLayout((l) => ({ ...l, ...p })),
    [],
  );

  const [sort, setSort] = useState<Sort[]>(props.initialSort);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 1 });
  const [editing, setEditingState] = useState<{ rowId: string; colId: string } | null>(null);
  // Mirrored in a ref so the deferred focus restore below never steals focus from an open editor
  // (keys arrive faster than an animation frame; the editor commits on blur).
  const editingRef = useRef<typeof editing>(null);
  const setEditing = useCallback((next: typeof editing) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── data ───────────────────────────────────────────────────────────────────
  const queryInput = useMemo(
    () => ({
      objectType: objectType.apiSlug,
      query: { filters, sort, search, limit: pageSize, includeDeleted: false },
    }),
    [objectType.apiSlug, filters, sort, search, pageSize],
  );
  // The cursor lives inside `query`, so this is a hand-rolled infinite query over the tRPC client.
  const queryKey = useMemo(() => ['records', queryInput] as const, [queryInput]);
  const infinite = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      client.record.query.query({
        ...queryInput,
        query: { ...queryInput.query, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  type Pages = typeof infinite.data;
  const pages = infinite.data?.pages;
  const total = pages?.[0]?.total ?? 0;
  const rows: GridRow[] = useMemo(
    () =>
      (pages ?? []).flatMap((p) =>
        p.items.map((i) => ({
          id: i.id,
          label: i.label,
          values: i.values,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        })),
      ),
    [pages],
  );

  const patchRow = useCallback(
    (id: string, values: Record<string, unknown>, label?: string) => {
      qc.setQueryData<Pages>(queryKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((i) =>
                  i.id === id
                    ? { ...i, values: { ...i.values, ...values }, label: label ?? i.label }
                    : i,
                ),
              })),
            }
          : old,
      );
    },
    [qc, queryKey],
  );
  const removeRows = useCallback(
    (ids: Set<string>) => {
      qc.setQueryData<Pages>(queryKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                total: Math.max(0, p.total - ids.size),
                items: p.items.filter((i) => !ids.has(i.id)),
              })),
            }
          : old,
      );
    },
    [qc, queryKey],
  );

  const update = useMutation(
    trpc.record.update.mutationOptions({
      onError: (e) => setNotice(e.message),
    }),
  );
  const bulkUpdate = useMutation(
    trpc.record.bulkUpdate.mutationOptions({ onError: (e) => setNotice(e.message) }),
  );
  const bulkDelete = useMutation(
    trpc.record.delete.mutationOptions({ onError: (e) => setNotice(e.message) }),
  );
  const addMany = useMutation(
    trpc.listEntry.addMany.mutationOptions({ onError: (e) => setNotice(e.message) }),
  );

  // ── columns ────────────────────────────────────────────────────────────────
  const columns = useMemo<ColumnDef<GridRow, unknown>[]>(() => {
    const select = helper.display({
      id: '_select',
      size: 40,
      enableResizing: false,
      header: ({ table }) => (
        <input
          type="checkbox"
          aria-label="Select all loaded rows"
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomeRowsSelected();
          }}
          onChange={table.getToggleAllRowsSelectedHandler()}
          tabIndex={-1}
        />
      ),
      cell: ({ row }) =>
        row.getIsGrouped() ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.label}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            tabIndex={-1}
          />
        ),
    });
    const labelAttr =
      attributes.find((a) => a.apiSlug === 'name') ?? attributes.find((a) => a.type === 'TEXT');
    const label = helper.accessor((r) => r.label, {
      id: '_label',
      header: objectType.singular,
      size: 240,
      meta: labelAttr ? { attr: labelAttr } : undefined,
      cell: ({ row, getValue }) =>
        row.getIsGrouped() ? null : (
          <a
            href={`/w/${slug}/records/${objectType.apiSlug}/${row.original.id}`}
            className="truncate font-medium text-link hover:underline"
            tabIndex={-1}
          >
            {String(getValue())}
          </a>
        ),
    });
    const attrCols = attributes
      .filter((a) => a.id !== labelAttr?.id)
      .map((a) =>
        helper.accessor((r) => r.values[a.id], {
          id: a.id,
          header: a.title,
          size: defaultWidth(a.type),
          enableGrouping: GROUPABLE.has(a.type),
          aggregationFn: NUMERIC.has(a.type) ? 'sum' : 'count',
          meta: { attr: a },
          cell: ({ getValue }) => <ValueCell attribute={a} value={getValue()} slug={slug} />,
        }),
      );
    const updated = helper.accessor((r) => r.updatedAt, {
      id: 'updatedAt',
      header: 'Updated',
      size: 160,
      cell: ({ getValue }) => (
        <span className="tnum text-ink-secondary">
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
            getValue(),
          )}
        </span>
      ),
    });
    return [select, label, ...attrCols, updated] as ColumnDef<GridRow, unknown>[];
  }, [attributes, objectType, slug]);

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      columnOrder: layout.columnOrder,
      columnSizing: layout.columnSizing,
      columnPinning: layout.columnPinning,
      columnVisibility: layout.columnVisibility,
      grouping: layout.grouping,
      rowSelection,
      expanded,
    },
    onColumnOrderChange: (u) =>
      patchLayout({ columnOrder: typeof u === 'function' ? u(layout.columnOrder) : u }),
    onColumnSizingChange: (u) =>
      patchLayout({ columnSizing: typeof u === 'function' ? u(layout.columnSizing) : u }),
    onColumnPinningChange: (u) =>
      patchLayout({ columnPinning: typeof u === 'function' ? u(layout.columnPinning) : u }),
    onColumnVisibilityChange: (u) =>
      patchLayout({ columnVisibility: typeof u === 'function' ? u(layout.columnVisibility) : u }),
    onGroupingChange: (u) =>
      patchLayout({ grouping: typeof u === 'function' ? u(layout.grouping) : u }),
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    getRowId: (r) => r.id,
    getCoreRowModel: getCoreRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    columnResizeMode: 'onChange',
    enableRowSelection: (row) => !row.getIsGrouped(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    groupedColumnMode: false,
  });

  const tableRows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();

  // ── virtualization + infinite scroll ───────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    // Grouped views collapse thousands of rows into a few group rows, which would otherwise look
    // like "near the end" forever and page through the whole table. Grouping is over loaded rows.
    if (layout.grouping.length) return;
    if (last.index >= tableRows.length - 40 && infinite.hasNextPage && !infinite.isFetchingNextPage)
      void infinite.fetchNextPage();
  }, [virtualItems, tableRows.length, infinite, layout.grouping.length]);

  // ── keyboard model ─────────────────────────────────────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const focusActive = useCallback(() => {
    if (editingRef.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-cell="${active.row}:${active.col}"]`,
    );
    el?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    if (active.row >= 0) virtualizer.scrollToIndex(active.row, { align: 'auto' });
    const t = requestAnimationFrame(focusActive);
    return () => cancelAnimationFrame(t);
  }, [active, focusActive, virtualizer]);

  // Only the cell itself moving into focus changes the active cell. Focus events bubble from a
  // cell editor or an open column menu; reacting to those would refocus the cell and close them.
  const onCellFocus = (e: React.FocusEvent, row: number, col: number) => {
    if (e.target !== e.currentTarget) return;
    setActive((a) => (a.row === row && a.col === col ? a : { row, col }));
  };

  const startEdit = (rowIndex: number, colIndex: number) => {
    const row = tableRows[rowIndex];
    const col = visibleColumns[colIndex];
    if (!row || !col || row.getIsGrouped()) return;
    const attr = col.columnDef.meta?.attr;
    if (!attr || !canEdit || !isInlineEditable(attr)) return;
    setEditing({ rowId: row.id, colId: col.id });
  };
  const stopEdit = () => {
    setEditing(null);
    focusActive();
  };

  const commitEdit = (rowId: string, attr: AttributeLike, next: unknown) => {
    stopEdit();
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const previous = row.values[attr.id];
    patchRow(rowId, { [attr.id]: next });
    update.mutate(
      { id: rowId, values: { [attr.id]: next } },
      {
        onSuccess: (r) => patchRow(rowId, r.values, r.label),
        onError: () => patchRow(rowId, { [attr.id]: previous }),
      },
    );
    focusActive();
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || menuFor) return;
    const maxRow = tableRows.length - 1;
    const maxCol = visibleColumns.length - 1;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setActive((a) => ({
        row: Math.max(-1, Math.min(maxRow, a.row + dr)),
        col: Math.max(0, Math.min(maxCol, a.col + dc)),
      }));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(1, 0);
      case 'ArrowUp':
        return move(-1, 0);
      case 'ArrowRight':
        return move(0, 1);
      case 'ArrowLeft':
        return move(0, -1);
      case 'PageDown':
        return move(20, 0);
      case 'PageUp':
        return move(-20, 0);
      case 'Home':
        e.preventDefault();
        return setActive((a) => ({ ...a, col: e.ctrlKey ? a.col : 0, row: e.ctrlKey ? 0 : a.row }));
      case 'End':
        e.preventDefault();
        return setActive((a) => ({
          ...a,
          col: e.ctrlKey ? a.col : maxCol,
          row: e.ctrlKey ? maxRow : a.row,
        }));
      case 'F2':
        e.preventDefault();
        return startEdit(active.row, active.col);
      case 'Enter': {
        e.preventDefault();
        if (active.row === -1) return setMenuFor(visibleColumns[active.col]?.id ?? null);
        const col = visibleColumns[active.col];
        const row = tableRows[active.row];
        if (col?.id === '_label' && row && !row.getIsGrouped())
          return router.push(`/w/${slug}/records/${objectType.apiSlug}/${row.id}`);
        if (row?.getIsGrouped()) return row.toggleExpanded();
        return startEdit(active.row, active.col);
      }
      case ' ': {
        const row = tableRows[active.row];
        if (row && !row.getIsGrouped()) {
          e.preventDefault();
          if (e.shiftKey || visibleColumns[active.col]?.id === '_select') row.toggleSelected();
          else return startEdit(active.row, active.col);
        }
        return;
      }
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          table.toggleAllRowsSelected(true);
        }
        return;
      case 'Escape':
        setRowSelection({});
        return;
      default:
        return;
    }
  };

  // ── column menu ────────────────────────────────────────────────────────────
  const menuItems = (col: Column<GridRow, unknown>): ColumnMenuItem[] => {
    const attr = col.columnDef.meta?.attr;
    const sortable = attr ? isSortable(attr.type) : col.id === 'updatedAt' || col.id === '_label';
    const pinned = col.getIsPinned();
    const order = visibleColumns.map((c) => c.id);
    const i = order.indexOf(col.id);
    return [
      { action: 'sort-asc', label: 'Sort ascending', disabled: !sortable },
      { action: 'sort-desc', label: 'Sort descending', disabled: !sortable },
      { action: 'sort-none', label: 'Clear sort', disabled: sort.length === 0 },
      { action: 'move-left', label: 'Move left', disabled: i <= 0 },
      { action: 'move-right', label: 'Move right', disabled: i >= order.length - 1 },
      {
        action: pinned === 'left' ? 'unpin' : 'pin-left',
        label: pinned === 'left' ? 'Unpin' : 'Pin left',
      },
      {
        action: pinned === 'right' ? 'unpin' : 'pin-right',
        label: pinned === 'right' ? 'Unpin' : 'Pin right',
      },
      {
        action: layout.grouping.includes(col.id) ? 'ungroup' : 'group',
        label: layout.grouping.includes(col.id) ? 'Ungroup' : 'Group by (loaded rows)',
        disabled: !col.getCanGroup(),
      },
      { action: 'autosize', label: 'Reset width' },
      {
        action: 'hide',
        label: 'Hide column',
        disabled: col.id === '_select' || col.id === '_label',
      },
    ];
  };
  const onMenuAction = (col: Column<GridRow, unknown>, a: ColumnMenuAction) => {
    const attr = col.columnDef.meta?.attr;
    const sortKey = attr ? attr.apiSlug : col.id === '_label' ? 'name' : col.id;
    const order = table.getAllLeafColumns().map((c) => c.id);
    const current = layout.columnOrder.length ? layout.columnOrder : order;
    const i = current.indexOf(col.id);
    switch (a) {
      case 'sort-asc':
        return setSort([{ attribute: sortKey, direction: 'asc' }]);
      case 'sort-desc':
        return setSort([{ attribute: sortKey, direction: 'desc' }]);
      case 'sort-none':
        return setSort([]);
      case 'move-left':
      case 'move-right': {
        const j = a === 'move-left' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= current.length) return;
        const next = [...current];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return patchLayout({ columnOrder: next });
      }
      case 'pin-left':
        return col.pin('left');
      case 'pin-right':
        return col.pin('right');
      case 'unpin':
        return col.pin(false);
      case 'group':
        return patchLayout({ grouping: [col.id] });
      case 'ungroup':
        return patchLayout({ grouping: [] });
      case 'hide':
        return col.toggleVisibility(false);
      case 'autosize':
        return col.resetSize();
    }
  };

  // ── bulk ───────────────────────────────────────────────────────────────────
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const busy = bulkUpdate.isPending || bulkDelete.isPending || addMany.isPending;
  const exportSelected = () => {
    const chosen = rows.filter((r) => rowSelection[r.id]);
    const headers = ['id', objectType.singular, ...attributes.map((a) => a.apiSlug)];
    const csv = toCsv(
      headers,
      chosen.map((r) => [r.id, r.label, ...attributes.map((a) => r.values[a.id])]),
    );
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${objectType.apiSlug}-selected.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── footer aggregates over loaded rows ─────────────────────────────────────
  const aggregates = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of attributes) {
      if (!NUMERIC.has(a.type)) continue;
      const nums = rows
        .map((r) => r.values[a.id])
        .filter((v): v is number => typeof v === 'number');
      if (nums.length === 0) continue;
      const sum = nums.reduce((s, n) => s + n, 0);
      const fmt = (n: number) =>
        a.type === 'CURRENCY' ? formatCurrency(n, currencyOf(a.config)) : formatNumber(n);
      out[a.id] = `Σ ${fmt(sum)} · avg ${fmt(sum / nums.length)}`;
    }
    return out;
  }, [attributes, rows]);

  // ── render ─────────────────────────────────────────────────────────────────
  if (infinite.isPending) return <TableSkeleton rows={8} cols={5} />;
  if (infinite.isError) {
    return (
      <ErrorState
        title="The records could not be loaded"
        message={infinite.error.message}
        onRetry={() => void infinite.refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          filters.length || search
            ? `No ${objectType.plural.toLowerCase()} match`
            : `No ${objectType.plural.toLowerCase()} yet`
        }
        description={
          filters.length || search
            ? 'Loosen the filters or clear the search.'
            : `Create one, or import a CSV.`
        }
      />
    );
  }

  const totalWidth = table.getTotalSize();
  const leftOffset = (col: Column<GridRow, unknown>) =>
    col.getIsPinned() === 'left' ? col.getStart('left') : undefined;
  const rightOffset = (col: Column<GridRow, unknown>) =>
    col.getIsPinned() === 'right' ? col.getAfter('right') : undefined;
  const stickyClass = (col: Column<GridRow, unknown>) =>
    col.getIsPinned() ? 'sticky z-10 bg-card' : '';

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-3 text-[var(--text-sm)] text-ink-secondary"
        aria-live="polite"
      >
        <span className="tnum">
          {rows.length.toLocaleString()} of {total.toLocaleString()} loaded
        </span>
        {layout.grouping.length ? (
          <span>
            Grouped by{' '}
            {attributes.find((a) => a.id === layout.grouping[0])?.title ?? layout.grouping[0]}{' '}
            (loaded rows)
          </span>
        ) : null}
        {sort[0] ? (
          <span>
            Sorted by{' '}
            {attributes.find((a) => a.apiSlug === sort[0]!.attribute)?.title ?? sort[0].attribute}{' '}
            {sort[0].direction}
          </span>
        ) : null}
        {notice ? (
          <span role="alert" className="text-critical">
            {notice}{' '}
            <button type="button" className="underline" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </span>
        ) : null}
        <span className="ml-auto text-ink-muted">
          Arrow keys move · Enter edits or opens · Space selects · Ctrl+A selects loaded
        </span>
      </div>

      <div
        ref={scrollRef}
        className="relative max-h-[calc(100dvh-14rem)] overflow-auto rounded-[var(--radius-card)] border border-hairline bg-card"
        onKeyDown={onGridKeyDown}
      >
        <div
          ref={gridRef}
          role="grid"
          aria-rowcount={total}
          aria-colcount={visibleColumns.length}
          aria-multiselectable="true"
          style={{ width: totalWidth, minWidth: '100%' }}
        >
          {/* header */}
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-20 flex border-b border-hairline bg-card text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted"
          >
            {visibleColumns.map((col, ci) => {
              const header = table
                .getHeaderGroups()[0]
                ?.headers.find((h) => h.column.id === col.id);
              const attr = col.columnDef.meta?.attr;
              const sorted =
                sort[0] &&
                (attr ? sort[0].attribute === attr.apiSlug : sort[0].attribute === col.id);
              return (
                <div
                  key={col.id}
                  role="columnheader"
                  aria-colindex={ci + 1}
                  aria-sort={
                    sorted ? (sort[0]!.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                  data-cell={`-1:${ci}`}
                  tabIndex={active.row === -1 && active.col === ci ? 0 : -1}
                  onFocus={(e) => onCellFocus(e, -1, ci)}
                  className={`relative flex h-9 shrink-0 items-center gap-1 px-2 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ink-link)] ${stickyClass(col)}`}
                  style={{ width: col.getSize(), left: leftOffset(col), right: rightOffset(col) }}
                >
                  {col.id === '_select' ? (
                    header ? (
                      flexRender(header.column.columnDef.header, header.getContext())
                    ) : null
                  ) : (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
                      onClick={() => setMenuFor(menuFor === col.id ? null : col.id)}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === col.id}
                      tabIndex={-1}
                    >
                      <span className="truncate">
                        {header
                          ? flexRender(header.column.columnDef.header, header.getContext())
                          : col.id}
                      </span>
                      {sorted ? (
                        <span aria-hidden>{sort[0]!.direction === 'asc' ? '↑' : '↓'}</span>
                      ) : null}
                      {col.getIsPinned() ? (
                        <span aria-hidden title="Pinned">
                          📌
                        </span>
                      ) : null}
                    </button>
                  )}
                  {col.getCanResize() ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${col.id === '_label' ? objectType.singular : (attr?.title ?? col.id)}`}
                      onMouseDown={header?.getResizeHandler()}
                      onTouchStart={header?.getResizeHandler()}
                      onDoubleClick={() => col.resetSize()}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-link"
                    />
                  ) : null}
                  {menuFor === col.id ? (
                    <ColumnMenu
                      title={attr?.title ?? (col.id === '_label' ? objectType.singular : 'Updated')}
                      items={menuItems(col)}
                      onAction={(a) => onMenuAction(col, a)}
                      onClose={() => {
                        setMenuFor(null);
                        focusActive();
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* body */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((vi) => {
              const row = tableRows[vi.index]!;
              const ri = vi.index;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={ri + 2}
                  aria-selected={row.getIsSelected() || undefined}
                  className={`absolute left-0 top-0 flex w-full border-b border-hairline text-[var(--text-sm)] ${row.getIsSelected() ? 'bg-raised' : 'hover:bg-raised'}`}
                  style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                >
                  {row.getIsGrouped()
                    ? (() => {
                        const g = row.groupingColumnId
                          ? table.getColumn(row.groupingColumnId)
                          : undefined;
                        const attr = g?.columnDef.meta?.attr;
                        return (
                          <div
                            role="gridcell"
                            aria-colindex={1}
                            data-cell={`${ri}:0`}
                            tabIndex={active.row === ri ? 0 : -1}
                            onFocus={(e) => onCellFocus(e, ri, 0)}
                            onClick={() => row.toggleExpanded()}
                            className="flex w-full items-center gap-2 px-2 font-medium outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ink-link)]"
                          >
                            <span aria-hidden>{row.getIsExpanded() ? '▾' : '▸'}</span>
                            <span>
                              {attr
                                ? optionLabel(
                                    attr.config,
                                    row.getGroupingValue(row.groupingColumnId!),
                                  )
                                : String(row.getGroupingValue(row.groupingColumnId!))}
                            </span>
                            <span className="tnum text-ink-muted">({row.subRows.length})</span>
                          </div>
                        );
                      })()
                    : row.getVisibleCells().map((cell, ci) => {
                        const col = cell.column;
                        const attr = col.columnDef.meta?.attr;
                        const isEditing = editing?.rowId === row.id && editing.colId === col.id;
                        return (
                          <div
                            key={cell.id}
                            role="gridcell"
                            aria-colindex={ci + 1}
                            data-cell={`${ri}:${ci}`}
                            tabIndex={active.row === ri && active.col === ci ? 0 : -1}
                            onFocus={(e) => onCellFocus(e, ri, ci)}
                            onDoubleClick={() => startEdit(ri, ci)}
                            className={`relative flex h-full shrink-0 items-center overflow-hidden px-2 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ink-link)] ${stickyClass(col)} ${attr && NUMERIC.has(attr.type) ? 'justify-end tnum' : ''}`}
                            style={{
                              width: col.getSize(),
                              left: leftOffset(col),
                              right: rightOffset(col),
                            }}
                          >
                            {isEditing && attr ? (
                              <CellEditor
                                attr={attr}
                                value={row.original.values[attr.id]}
                                onCommit={(v) => commitEdit(row.id, attr, v)}
                                onCancel={stopEdit}
                              />
                            ) : (
                              <span className="truncate">
                                {flexRender(col.columnDef.cell, cell.getContext())}
                              </span>
                            )}
                          </div>
                        );
                      })}
                </div>
              );
            })}
          </div>

          {/* footer aggregates */}
          <div
            role="row"
            aria-rowindex={total + 2}
            className="sticky bottom-0 z-10 flex border-t border-hairline bg-card text-[var(--text-xs)] text-ink-secondary"
          >
            {visibleColumns.map((col) => {
              const attr = col.columnDef.meta?.attr;
              return (
                <div
                  key={col.id}
                  role="gridcell"
                  className={`flex h-8 shrink-0 items-center px-2 tnum ${stickyClass(col)} ${attr && NUMERIC.has(attr.type) ? 'justify-end' : ''}`}
                  style={{ width: col.getSize(), left: leftOffset(col), right: rightOffset(col) }}
                >
                  {col.id === '_label'
                    ? `${rows.length.toLocaleString()} loaded`
                    : attr
                      ? (aggregates[attr.id] ?? '')
                      : ''}
                </div>
              );
            })}
          </div>
        </div>
        {infinite.isFetchingNextPage ? (
          <div
            className="sticky bottom-8 px-2 py-1 text-[var(--text-xs)] text-ink-muted"
            aria-live="polite"
          >
            Loading more…
          </div>
        ) : null}
      </div>

      <BulkBar
        count={selectedIds.length}
        attributes={attributes.filter((a) => isInlineEditable(a))}
        lists={lists}
        canDelete={canDelete}
        canEdit={canEdit}
        busy={busy}
        onClear={() => setRowSelection({})}
        onDelete={() => {
          const ids = new Set(selectedIds);
          bulkDelete.mutate(
            { ids: selectedIds },
            {
              onSuccess: () => {
                removeRows(ids);
                setRowSelection({});
              },
            },
          );
        }}
        onAddToList={(listId) =>
          addMany.mutate(
            { listId, recordIds: selectedIds },
            {
              onSuccess: (r) =>
                setNotice(`Added ${r.added}, skipped ${r.skipped} already in the list.`),
            },
          )
        }
        onSetField={(attributeId, value) =>
          bulkUpdate.mutate(
            { ids: selectedIds, values: { [attributeId]: value } },
            {
              onSuccess: (r) => {
                for (const id of selectedIds) patchRow(id, { [attributeId]: value });
                setNotice(`Updated ${r.updated}.`);
              },
            },
          )
        }
        onExport={exportSelected}
      />
    </div>
  );
}
