'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { Role } from '@nexus/db';
import { RoleBadge } from '@/components/role-badge';

export type SwitcherWorkspace = { id: string; name: string; slug: string; role: Role };

/**
 * Native `<details>` menu: keyboard reachable without JavaScript, closes on Escape and on
 * clicks outside. The list is server-rendered by the layout and passed in.
 */
export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: { name: string; slug: string; role: Role };
  workspaces: SwitcherWorkspace[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && el.open) {
        el.open = false;
        el.querySelector('summary')?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (el.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <details ref={ref} className="relative">
      <summary
        className="flex h-[var(--control-height)] cursor-pointer list-none items-center gap-2 rounded-[var(--radius-control)] border border-hairline bg-card px-2.5 text-[var(--text-sm)] hover:border-strong [&::-webkit-details-marker]:hidden"
        aria-label={`Workspace: ${current.name}. Switch workspace`}
      >
        <span className="max-w-[16rem] truncate font-medium">{current.name}</span>
        <RoleBadge role={current.role} />
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div
        role="menu"
        aria-label="Workspaces"
        className="absolute left-0 top-[calc(100%+4px)] z-20 w-72 rounded-[var(--radius-card)] border border-hairline bg-raised p-1"
      >
        <p className="px-2.5 pb-1 pt-1.5 text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
          Your workspaces
        </p>
        <ul className="max-h-72 overflow-y-auto">
          {workspaces.map((w) => {
            const active = w.slug === current.slug;
            return (
              <li key={w.id}>
                <Link
                  role="menuitem"
                  href={`/w/${w.slug}`}
                  aria-current={active ? 'true' : undefined}
                  className={[
                    'flex h-9 items-center justify-between gap-3 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] hover:bg-card',
                    active ? 'font-medium' : '',
                  ].join(' ')}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {active ? (
                      <span aria-hidden className="text-ink">
                        ✓
                      </span>
                    ) : (
                      <span aria-hidden className="w-3" />
                    )}
                    <span className="truncate">{w.name}</span>
                  </span>
                  <RoleBadge role={w.role} />
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-hairline pt-1">
          <Link
            role="menuitem"
            href="/new"
            className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] text-ink-secondary hover:bg-card hover:text-ink"
          >
            <span aria-hidden className="w-3 text-center">
              +
            </span>
            New workspace
          </Link>
        </div>
      </div>
    </details>
  );
}
