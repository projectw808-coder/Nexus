'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Settings sub-navigation. Active tab from the pathname; `aria-current` marks it. */
export function SettingsTabs({ tabs }: { tabs: { label: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="border-b border-hairline">
      <ul className="-mb-px flex gap-1">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex h-9 items-center border-b-2 px-3 text-[var(--text-sm)] transition-colors duration-[var(--duration-state)]',
                  active
                    ? 'border-ink font-medium text-ink'
                    : 'border-transparent text-ink-secondary hover:border-strong hover:text-ink',
                ].join(' ')}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
