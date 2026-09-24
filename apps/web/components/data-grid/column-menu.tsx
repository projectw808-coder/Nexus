'use client';

import { useEffect, useId, useRef } from 'react';

export type ColumnMenuAction =
  | 'sort-asc'
  | 'sort-desc'
  | 'sort-none'
  | 'pin-left'
  | 'pin-right'
  | 'unpin'
  | 'move-left'
  | 'move-right'
  | 'group'
  | 'ungroup'
  | 'hide'
  | 'autosize';

export type ColumnMenuItem = { action: ColumnMenuAction; label: string; disabled?: boolean };

/**
 * A small menu (role=menu) opened from a column header. Arrow keys move, Enter/Space activate,
 * Escape closes and returns focus to the header. Every table capability that is a drag with a
 * mouse (reorder, resize, pin) has an item here, so it is reachable from the keyboard (§12.2.D).
 */
export function ColumnMenu({
  title,
  items,
  onAction,
  onClose,
}: {
  title: string;
  items: ColumnMenuItem[];
  onAction: (a: ColumnMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // Focus the first item once, on open. (Re-running this on every render would yank focus back
  // to the first item whenever the parent re-rendered, breaking arrow-key and pointer selection.)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const move = (dir: 1 | -1) => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(i + dir + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-labelledby={`${id}-title`}
      className="absolute left-0 top-full z-30 mt-1 min-w-44 rounded-[var(--radius-card)] border border-hairline bg-raised p-1 text-[var(--text-sm)] shadow-[var(--elevation-2)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Tab') {
          onClose();
        } else {
          e.stopPropagation();
        }
      }}
    >
      <div
        id={`${id}-title`}
        className="px-2 py-1 text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted"
      >
        {title}
      </div>
      {items.map((it) => (
        <button
          key={it.action}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onAction(it.action);
            onClose();
          }}
          className="block w-full rounded-[var(--radius-control)] px-2 py-1 text-left hover:bg-card focus-visible:bg-card disabled:opacity-50"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
