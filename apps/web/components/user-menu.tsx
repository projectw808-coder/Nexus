'use client';

import { ChevronDown, Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { Role } from '@nexus/db';
import type { Theme } from '@nexus/ui';
import { ROLE_LABEL } from '@/lib/roles';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';

export type MenuWorkspace = { id: string; name: string; slug: string; role: Role };

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * Avatar, name and role, opening on the workspaces, theme and sign-out. Native `<details>` like
 * the old switcher: reachable and operable without JavaScript, closes on Escape / outside click.
 */
export function UserMenu({
  user,
  role,
  currentSlug,
  workspaces,
  theme,
}: {
  user: { name: string | null; email: string };
  role: Role;
  currentSlug: string;
  workspaces: MenuWorkspace[];
  theme: Theme;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const display = user.name ?? user.email;

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
        aria-label={`${display}, ${ROLE_LABEL[role]}. Account and workspace menu`}
        className="flex cursor-pointer list-none items-center gap-3 rounded-[var(--radius-control)] py-1 pl-1 pr-1.5 hover:bg-raised [&::-webkit-details-marker]:hidden"
      >
        <span
          aria-hidden
          className="grid size-[35px] shrink-0 place-items-center rounded-full border border-strong bg-page text-[12px] font-semibold text-[#9cd2ff]"
        >
          {initialsOf(display)}
        </span>
        <span className="hidden min-w-0 text-left leading-tight sm:block">
          <span className="block max-w-[10rem] truncate text-[12px] font-bold">{display}</span>
          <span className="mt-1 block text-[12px] text-ink-muted">{ROLE_LABEL[role]}</span>
        </span>
        <ChevronDown aria-hidden size={16} className="text-ink-secondary" />
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-72 rounded-[var(--radius-card)] border border-hairline bg-raised p-1 shadow-[var(--elevation-2)]">
        <div className="border-b border-hairline px-2.5 pb-2 pt-1.5">
          <p className="truncate text-[var(--text-sm)] font-medium">{display}</p>
          {user.name ? (
            <p className="truncate text-[var(--text-xs)] text-ink-muted">{user.email}</p>
          ) : null}
        </div>
        <p className="px-2.5 pb-1 pt-2 text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
          Workspaces
        </p>
        <ul className="max-h-60 overflow-y-auto">
          {workspaces.map((w) => {
            const active = w.slug === currentSlug;
            return (
              <li key={w.id}>
                <Link
                  href={`/w/${w.slug}`}
                  aria-current={active ? 'true' : undefined}
                  className={[
                    'flex h-9 items-center justify-between gap-3 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] hover:bg-card',
                    active ? 'font-medium text-ink' : 'text-ink-secondary',
                  ].join(' ')}
                >
                  <span className="truncate">{w.name}</span>
                  <span className="text-[var(--text-xs)] text-ink-muted">{ROLE_LABEL[w.role]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <Link
          href="/new"
          className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] text-ink-secondary hover:bg-card hover:text-ink"
        >
          <Plus aria-hidden size={14} /> New workspace
        </Link>
        <div className="mt-1 flex flex-col gap-2 border-t border-hairline px-2.5 pb-1.5 pt-2.5">
          <ThemeToggle initial={theme} />
          <div className="flex items-center justify-between">
            <Link
              href={`/w/${currentSlug}/settings`}
              className="flex items-center gap-1.5 text-[var(--text-sm)] text-ink-secondary hover:text-ink"
            >
              <Settings aria-hidden size={14} /> Settings
            </Link>
            <SignOutButton />
          </div>
        </div>
      </div>
    </details>
  );
}
