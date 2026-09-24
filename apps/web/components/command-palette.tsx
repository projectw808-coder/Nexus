'use client';

/**
 * ⌘K command palette (§12.1): navigation and creation commands plus live cross-object search.
 * A dialog with a combobox: ⌘K/Ctrl+K opens, typing filters commands and (after two
 * characters) searches records, ↑/↓ move, Enter runs, Escape closes. Focus returns to where it
 * came from.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTRPC } from '@/lib/trpc-client';

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: 'Go to' | 'Create' | 'Settings';
};

export function CommandPalette({ commands }: { commands: PaletteCommand[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const trpc = useTRPC();
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        restoreRef.current = document.activeElement as HTMLElement;
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    document.documentElement.dataset['palette'] = 'ready'; // hydration marker for tests
    return () => {
      window.removeEventListener('keydown', onKey);
      delete document.documentElement.dataset['palette'];
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setIndex(0);
    restoreRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const debounced = useDebounced(q.trim(), 200);
  const search = useQuery({
    ...trpc.search.global.queryOptions({ q: debounced, limitPerObject: 5 }),
    enabled: open && debounced.length >= 2,
  });

  const filteredCommands = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? commands.filter(
          (c) =>
            c.label.toLowerCase().includes(needle) || (c.hint ?? '').toLowerCase().includes(needle),
        )
      : commands;
  }, [commands, q]);

  const items = useMemo(() => {
    const out: { id: string; label: string; hint?: string; href: string; group: string }[] =
      filteredCommands.map((c) => ({ ...c }));
    for (const g of search.data?.groups ?? []) {
      for (const r of g.items)
        out.push({
          id: `rec:${r.id}`,
          label: r.label,
          hint: g.objectType.singular,
          href: `/w/${slugFromCommands(commands)}/records/${g.objectType.apiSlug}/${r.id}`,
          group: g.objectType.plural,
        });
    }
    return out;
  }, [filteredCommands, search.data, commands]);

  if (!open) return null;

  const safeIndex = Math.min(index, Math.max(0, items.length - 1));
  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    router.push(it.href);
  };

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(11,11,11,0.35)] p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-[var(--radius-card)] border border-hairline bg-raised shadow-[var(--elevation-2)]"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[safeIndex] ? `${listId}-${safeIndex}` : undefined}
          aria-autocomplete="list"
          placeholder="Type a command or search…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(safeIndex);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className="h-12 w-full border-b border-hairline bg-transparent px-4 text-[var(--text-md)] text-ink outline-none placeholder:text-ink-muted"
        />
        <ul
          id={listId}
          role="listbox"
          className="max-h-[50vh] overflow-auto p-1 text-[var(--text-sm)]"
        >
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-ink-muted" role="presentation">
              {search.isFetching ? 'Searching…' : 'No commands or records match.'}
            </li>
          ) : (
            items.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              return (
                <li key={it.id} role="presentation">
                  {header ? (
                    <div className="px-3 pb-1 pt-2 text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
                      {header}
                    </div>
                  ) : null}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === safeIndex}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(i)}
                    className={`flex cursor-pointer items-center justify-between rounded-[var(--radius-control)] px-3 py-1.5 ${i === safeIndex ? 'bg-card' : ''}`}
                  >
                    <span className="truncate">{it.label}</span>
                    {it.hint ? (
                      <span className="ml-3 shrink-0 text-ink-muted">{it.hint}</span>
                    ) : null}
                  </div>
                </li>
              );
            })
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-hairline px-3 py-1.5 text-[var(--text-xs)] text-ink-muted">
          <span>↑↓ move · Enter open · Esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}

function slugFromCommands(commands: PaletteCommand[]): string {
  const m = commands[0]?.href.match(/^\/w\/([^/]+)/);
  return m?.[1] ?? '';
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
