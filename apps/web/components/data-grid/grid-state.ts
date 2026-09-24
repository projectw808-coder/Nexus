/**
 * Per-viewer grid layout (column order, widths, pins, hidden columns, grouping) kept in
 * localStorage under one key per object type. This is a convenience, never shared state:
 * saved views (server) carry filters/sorts/columns for a team; this only remembers how one
 * person arranged the columns on their screen. Every access is guarded — storage can be
 * blocked, full or absent.
 */
import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  GroupingState,
  VisibilityState,
} from '@tanstack/react-table';

export type GridLayout = {
  columnOrder: ColumnOrderState;
  columnSizing: ColumnSizingState;
  columnPinning: ColumnPinningState;
  columnVisibility: VisibilityState;
  grouping: GroupingState;
};

export const EMPTY_LAYOUT: GridLayout = {
  columnOrder: [],
  columnSizing: {},
  columnPinning: { left: ['_select', '_label'], right: [] },
  columnVisibility: {},
  grouping: [],
};

const KEY = (objectTypeId: string) => `nexus.grid.${objectTypeId}`;

export function loadLayout(objectTypeId: string): GridLayout {
  try {
    const raw = window.localStorage.getItem(KEY(objectTypeId));
    if (!raw) return EMPTY_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<GridLayout>;
    return {
      columnOrder: Array.isArray(parsed.columnOrder) ? parsed.columnOrder : [],
      columnSizing:
        parsed.columnSizing && typeof parsed.columnSizing === 'object' ? parsed.columnSizing : {},
      columnPinning:
        parsed.columnPinning && typeof parsed.columnPinning === 'object'
          ? parsed.columnPinning
          : EMPTY_LAYOUT.columnPinning,
      columnVisibility:
        parsed.columnVisibility && typeof parsed.columnVisibility === 'object'
          ? parsed.columnVisibility
          : {},
      grouping: Array.isArray(parsed.grouping) ? parsed.grouping : [],
    };
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function saveLayout(objectTypeId: string, layout: GridLayout): void {
  try {
    window.localStorage.setItem(KEY(objectTypeId), JSON.stringify(layout));
  } catch {
    /* storage blocked or full: the layout simply does not persist */
  }
}

export function clearLayout(objectTypeId: string): void {
  try {
    window.localStorage.removeItem(KEY(objectTypeId));
  } catch {
    /* ignore */
  }
}

/** Default column width per attribute type, in px. */
export function defaultWidth(type: string): number {
  switch (type) {
    case 'BOOLEAN':
    case 'RATING':
      return 96;
    case 'NUMBER':
    case 'CURRENCY':
    case 'DATE':
      return 128;
    case 'DATETIME':
    case 'SELECT':
    case 'STATUS':
    case 'PHONE':
      return 160;
    case 'EMAIL':
    case 'URL':
    case 'RELATIONSHIP':
    case 'MULTISELECT':
      return 220;
    default:
      return 200;
  }
}
