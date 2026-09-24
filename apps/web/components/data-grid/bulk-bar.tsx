'use client';

import { useState } from 'react';
import type { AttributeLike } from '@/lib/attributes';
import { optionsOf } from '@/lib/attributes';
import { Button } from '@/components/button';
import { CONTROL_CLASS } from '@/components/field';

export type ListOption = { id: string; name: string; kind: 'PIPELINE' | 'COLLECTION' };

/**
 * Bulk actions for the current selection (§12.2.D): delete, add to list, set a field, export.
 * A live region announces the count; each action is a plain button so it is keyboard reachable.
 */
export function BulkBar({
  count,
  attributes,
  lists,
  canDelete,
  canEdit,
  busy,
  onClear,
  onDelete,
  onAddToList,
  onSetField,
  onExport,
}: {
  count: number;
  attributes: AttributeLike[];
  lists: ListOption[];
  canDelete: boolean;
  canEdit: boolean;
  busy: boolean;
  onClear: () => void;
  onDelete: () => void;
  onAddToList: (listId: string) => void;
  onSetField: (attributeId: string, value: unknown) => void;
  onExport: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'delete' | 'list' | 'field'>('idle');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [attrId, setAttrId] = useState(attributes[0]?.id ?? '');
  const [fieldValue, setFieldValue] = useState('');
  const attr = attributes.find((a) => a.id === attrId);

  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky bottom-2 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-hairline bg-raised px-3 py-2 text-[var(--text-sm)] shadow-[var(--elevation-2)]"
    >
      <span aria-live="polite" className="tnum font-medium">
        {count} selected
      </span>
      {mode === 'idle' ? (
        <>
          {canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMode('field')}
              disabled={busy || attributes.length === 0}
            >
              Set field…
            </Button>
          ) : null}
          {canEdit && lists.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setMode('list')} disabled={busy}>
              Add to list…
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={onExport} disabled={busy}>
            Export selected
          </Button>
          {canDelete ? (
            <Button size="sm" variant="danger" onClick={() => setMode('delete')} disabled={busy}>
              Delete…
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
            Clear
          </Button>
        </>
      ) : mode === 'delete' ? (
        <>
          <span>
            Delete {count} {count === 1 ? 'record' : 'records'}? They can be restored from the
            record page.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setMode('idle')}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => {
              onDelete();
              setMode('idle');
            }}
          >
            Delete
          </Button>
        </>
      ) : mode === 'list' ? (
        <>
          <label className="sr-only" htmlFor="bulk-list">
            List
          </label>
          <select
            id="bulk-list"
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            className={`${CONTROL_CLASS} h-8 w-auto`}
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => setMode('idle')}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !listId}
            onClick={() => {
              onAddToList(listId);
              setMode('idle');
            }}
          >
            Add
          </Button>
        </>
      ) : (
        <>
          <label className="sr-only" htmlFor="bulk-attr">
            Field
          </label>
          <select
            id="bulk-attr"
            value={attrId}
            onChange={(e) => {
              setAttrId(e.target.value);
              setFieldValue('');
            }}
            className={`${CONTROL_CLASS} h-8 w-auto`}
          >
            {attributes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="bulk-value">
            Value
          </label>
          {attr && (attr.type === 'SELECT' || attr.type === 'STATUS') ? (
            <select
              id="bulk-value"
              value={fieldValue}
              onChange={(e) => setFieldValue(e.target.value)}
              className={`${CONTROL_CLASS} h-8 w-auto`}
            >
              <option value="">— clear —</option>
              {optionsOf(attr.config).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : attr?.type === 'BOOLEAN' ? (
            <select
              id="bulk-value"
              value={fieldValue}
              onChange={(e) => setFieldValue(e.target.value)}
              className={`${CONTROL_CLASS} h-8 w-auto`}
            >
              <option value="">— clear —</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              id="bulk-value"
              value={fieldValue}
              onChange={(e) => setFieldValue(e.target.value)}
              placeholder="Value (empty clears)"
              className={`${CONTROL_CLASS} h-8 w-48`}
            />
          )}
          <Button size="sm" variant="secondary" onClick={() => setMode('idle')}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !attr}
            onClick={() => {
              if (!attr) return;
              onSetField(attr.id, coerce(attr, fieldValue));
              setMode('idle');
            }}
          >
            Apply to {count}
          </Button>
        </>
      )}
    </div>
  );
}

function coerce(attr: AttributeLike, raw: string): unknown {
  if (raw === '') return null;
  switch (attr.type) {
    case 'NUMBER':
    case 'CURRENCY':
    case 'RATING':
      return Number(raw);
    case 'BOOLEAN':
      return raw === 'true';
    case 'MULTISELECT':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}
