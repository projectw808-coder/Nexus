'use client';

import {
  Bot,
  CalendarCheck,
  ChartColumnIncreasing,
  ChartNoAxesColumn,
  Copy,
  Database,
  House,
  Kanban,
  ListChecks,
  Mail,
  Megaphone,
  Plug,
  Settings,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Role } from '@nexus/db';
import { canManage } from '@/lib/roles';

export type RailCounts = { newLeads: number; followUpsDue: number; unread: number };

type Item = {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: { count: number; tone: 'orange' | 'red'; label: string };
};

function groupsFor(slug: string, role: Role, counts: RailCounts, pipelineHref: string) {
  const base = `/w/${slug}`;
  const badge = (count: number, tone: 'orange' | 'red', label: string) =>
    count > 0 ? { count, tone, label } : undefined;
  return [
    {
      title: 'Workspace',
      items: [
        { label: 'Dashboard', href: base, icon: House, exact: true },
        {
          label: 'Clients',
          href: `${base}/clients`,
          icon: Users,
          badge: badge(counts.newLeads, 'orange', 'new leads'),
        },
        { label: 'Pipeline', href: pipelineHref, icon: Kanban },
        {
          label: 'Tasks & Follow-ups',
          href: `${base}/follow-ups`,
          icon: CalendarCheck,
          badge: badge(counts.followUpsDue, 'red', 'follow-ups due'),
        },
        {
          label: 'Inbox',
          href: `${base}/inbox`,
          icon: Mail,
          badge: badge(counts.unread, 'red', 'unread conversations'),
        },
      ] satisfies Item[],
    },
    {
      title: 'Management',
      items: [
        { label: 'Team Performance', href: `${base}/team`, icon: ChartNoAxesColumn },
        { label: 'Reports', href: `${base}/reports`, icon: ChartColumnIncreasing },
        { label: 'Campaigns', href: `${base}/campaigns`, icon: Megaphone },
        { label: 'Records', href: `${base}/records`, icon: Database },
        { label: 'Lists', href: `${base}/lists`, icon: ListChecks },
        { label: 'Duplicates', href: `${base}/duplicates`, icon: Copy },
      ] satisfies Item[],
    },
    {
      title: 'System',
      items: [
        { label: 'Automations', href: `${base}/automations`, icon: Zap },
        { label: 'Integrations', href: `${base}/settings/integrations`, icon: Plug },
        // Owner/admin only — mirrors the `AiAssistant` CASL subject (server/abilities.ts).
        ...(canManage(role)
          ? [{ label: 'AI assistant', href: `${base}/assistant`, icon: Bot }]
          : []),
        { label: 'Settings', href: `${base}/settings`, icon: Settings },
      ] satisfies Item[],
    },
  ];
}

/**
 * The left navigation (§12.1), grouped Workspace / Management / System with live badges, and the
 * Pantera GP card at the foot. Below `lg` it narrows to icons; the labels stay for screen readers.
 */
export function Rail({
  slug,
  role,
  counts,
  pipelineHref,
}: {
  slug: string;
  role: Role;
  counts: RailCounts;
  pipelineHref: string;
}) {
  const pathname = usePathname();
  const groups = groupsFor(slug, role, counts, pipelineHref);
  const items: Item[] = groups.flatMap((g) => g.items);
  // Hrefs nest (Settings vs. Integrations' /settings/integrations): only the most specific
  // matching one lights up, or a nested route highlights two items at once.
  const activeHref = items
    .filter((i) =>
      i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav
      aria-label="Workspace"
      className="flex w-16 shrink-0 flex-col gap-3 overflow-y-auto border-r border-hairline bg-[linear-gradient(var(--surface-card),var(--surface-page))] px-2 py-4 lg:w-[230px]"
    >
      {groups.map((group) => (
        <div key={group.title}>
          <p className="hidden px-[13px] pb-2 pt-0.5 text-[12px] font-medium uppercase tracking-[1px] text-ink-muted lg:block">
            {group.title}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = item.href === activeHref;
              const Icon = item.icon;
              return (
                <li key={item.label}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    title={item.label}
                    className={[
                      'flex h-[35px] items-center justify-center gap-2.5 rounded-[5px] px-3 text-[13.5px] transition-colors duration-[var(--duration-state)] lg:justify-start',
                      active
                        ? 'border-l-[3px] border-link bg-[linear-gradient(90deg,rgba(255,121,30,0.32),rgba(255,121,30,0.06))] pl-[9px] font-bold text-ink'
                        : 'text-ink-secondary hover:bg-raised hover:text-ink',
                    ].join(' ')}
                  >
                    <Icon aria-hidden size={19} className="shrink-0" />
                    <span className="sr-only flex-1 truncate lg:not-sr-only lg:whitespace-nowrap">
                      {item.label}
                    </span>
                    {item.badge ? (
                      <span
                        className={[
                          'hidden min-w-6 rounded-[5px] px-1.5 py-0.5 text-center text-[11px] font-semibold lg:inline',
                          item.badge.tone === 'orange'
                            ? 'bg-link text-ink-inverse'
                            : 'bg-[#d92d43] text-white',
                        ].join(' ')}
                      >
                        {item.badge.count}
                        <span className="sr-only"> {item.badge.label}</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="relative mt-auto hidden min-h-[116px] shrink-0 overflow-hidden [@media(max-height:820px)]:!hidden rounded-[11px] border border-[#483020] bg-[radial-gradient(circle_at_100%_100%,#44210c,var(--surface-card)_58%)] p-4 lg:block">
        <p className="text-[18px] font-bold text-link">Pantera GP</p>
        <p className="mt-2 text-[12px] leading-[1.6] text-ink-secondary">
          Financial Solutions
          <br />
          Sales CRM
        </p>
        <span
          aria-hidden
          className="absolute -bottom-[91px] -right-[45px] size-[145px] rounded-full border-2 border-[#fb6c08] shadow-[0_0_28px_#b44712]"
        />
      </div>
    </nav>
  );
}
