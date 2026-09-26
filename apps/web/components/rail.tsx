'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export const RAIL_COOKIE = 'nexus-rail';

type RailItem =
  | { kind: 'link'; label: string; href: string; icon: ReactNode; exact?: boolean }
  | { kind: 'planned'; label: string; phase: number; icon: ReactNode };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const Icon = {
  home: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z" />
    </svg>
  ),
  inbox: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M3 11h4l1.5 2h3L13 11h4M3 11l2-6h10l2 6v5H3z" />
    </svg>
  ),
  records: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M3 8h14M8 8v8" />
    </svg>
  ),
  lists: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M7 5h10M7 10h10M7 15h10M3.5 5h.01M3.5 10h.01M3.5 15h.01" />
    </svg>
  ),
  reports: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M3 16h14M5 13V9M9 13V5M13 13v-3M17 13V7" />
    </svg>
  ),
  automations: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M11 3 4 11h5l-1 6 8-9h-5z" />
    </svg>
  ),
  integrations: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v2" />
    </svg>
  ),
  duplicates: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <circle cx="7.5" cy="10" r="4.5" />
      <circle cx="12.5" cy="10" r="4.5" />
    </svg>
  ),
  settings: (
    <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M5.1 14.9l1.4-1.4M13.5 6.5l1.4-1.4" />
    </svg>
  ),
};

function itemsFor(slug: string): RailItem[] {
  const base = `/w/${slug}`;
  return [
    { kind: 'link', label: 'Home', href: base, icon: Icon.home, exact: true },
    { kind: 'link', label: 'Inbox', href: `${base}/inbox`, icon: Icon.inbox },
    { kind: 'link', label: 'Records', href: `${base}/records`, icon: Icon.records },
    { kind: 'link', label: 'Lists', href: `${base}/lists`, icon: Icon.lists },
    { kind: 'link', label: 'Duplicates', href: `${base}/duplicates`, icon: Icon.duplicates },
    { kind: 'link', label: 'Reports', href: `${base}/reports`, icon: Icon.reports },
    { kind: 'link', label: 'Automations', href: `${base}/automations`, icon: Icon.automations },
    {
      kind: 'link',
      label: 'Integrations',
      href: `${base}/settings/integrations`,
      icon: Icon.integrations,
    },
    { kind: 'link', label: 'Settings', href: `${base}/settings`, icon: Icon.settings },
  ];
}

/**
 * Left rail (§12.1): 64px collapsed, 240px expanded. The choice persists in a cookie so the
 * server renders the same width on the next request. Every destination is live as of Phase 11;
 * the `planned` variant stays so a future screen can be announced with the phase that ships it.
 */
export function Rail({ slug, initialCollapsed }: { slug: string; initialCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const pathname = usePathname();
  const items = itemsFor(slug);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${RAIL_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <nav
      aria-label="Workspace"
      data-collapsed={collapsed ? '' : undefined}
      className="flex shrink-0 flex-col border-r border-hairline bg-page transition-[width] duration-[var(--duration-layout)] ease-[var(--ease-standard)]"
      style={{ width: collapsed ? 'var(--rail-collapsed)' : 'var(--rail-expanded)' }}
    >
      <ul className="flex flex-1 flex-col gap-0.5 p-2">
        {items.map((item) => {
          const rowClass =
            'flex h-9 items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] ' +
            (collapsed ? 'justify-center' : '');
          if (item.kind === 'link') {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  className={[
                    rowClass,
                    'transition-colors duration-[var(--duration-state)]',
                    active
                      ? 'bg-raised font-medium text-ink'
                      : 'text-ink-secondary hover:bg-raised hover:text-ink',
                  ].join(' ')}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
                </Link>
              </li>
            );
          }
          return (
            <li key={item.label}>
              <span
                aria-disabled="true"
                title={collapsed ? `${item.label} — Phase ${item.phase}` : undefined}
                className={`${rowClass} cursor-not-allowed text-ink-muted`}
              >
                <span className="shrink-0">{item.icon}</span>
                <span
                  className={
                    collapsed ? 'sr-only' : 'flex min-w-0 flex-1 items-center justify-between gap-2'
                  }
                >
                  <span className="truncate">{item.label}</span>
                  <span className="shrink-0 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4">
                    Phase {item.phase}
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-hairline p-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className={[
            'flex h-9 w-full items-center gap-3 rounded-[var(--radius-control)] px-2.5 text-[var(--text-sm)] text-ink-secondary hover:bg-raised hover:text-ink',
            collapsed ? 'justify-center' : '',
          ].join(' ')}
        >
          <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" {...stroke}>
            {collapsed ? <path d="M7 5l5 5-5 5" /> : <path d="M13 5l-5 5 5 5" />}
          </svg>
          <span className={collapsed ? 'sr-only' : ''}>Collapse</span>
        </button>
      </div>
    </nav>
  );
}
