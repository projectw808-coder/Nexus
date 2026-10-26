import { Bell } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, type Theme } from '@nexus/ui';
import { BrandMark } from '@/components/brand-mark';
import { CommandPalette, type PaletteCommand } from '@/components/command-palette';
import { GlobalSearch } from '@/components/global-search';
import { Rail } from '@/components/rail';
import { UserMenu } from '@/components/user-menu';
import { TrpcProvider } from '@/lib/trpc-client';
import { api } from '@/lib/api';
import { requireSessionUser } from '@/lib/session';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * The app shell (§12.1): one 56px top bar (brand, global search, follow-up bell, account menu),
 * the grouped left navigation and the content pane, filling the viewport. Screens that want the
 * whole pane edge to edge (Clients) cancel the pane's padding themselves.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireSessionUser();
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const [workspaces, cookieStore, objectTypes, lists, counts] = await Promise.all([
    (await api()).workspace.list(),
    cookies(),
    client.objectType.list().catch(() => []),
    client.list.list().catch(() => []),
    client.clientWorkspace
      .counts()
      .catch(() => ({ newLeads: 0, followUpsDue: 0, overdue: 0, unread: 0 })),
  ]);
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';
  const base = `/w/${workspace.slug}`;
  const clientTypeId = objectTypes.find((o) => o.apiSlug === 'client')?.id;
  const clientPipeline = lists.find(
    (l) => l.kind === 'PIPELINE' && l.objectTypeId === clientTypeId,
  );
  const pipelineHref = clientPipeline ? `${base}/lists/${clientPipeline.id}` : `${base}/lists`;
  const commands: PaletteCommand[] = [
    { id: 'home', label: 'Dashboard', href: base, group: 'Go to' },
    { id: 'clients', label: 'Clients', href: `${base}/clients`, group: 'Go to' },
    { id: 'pipeline', label: 'Pipeline', href: pipelineHref, group: 'Go to' },
    {
      id: 'follow-ups',
      label: 'Tasks & Follow-ups',
      href: `${base}/follow-ups`,
      group: 'Go to',
    },
    { id: 'team', label: 'Team Performance', href: `${base}/team`, group: 'Go to' },
    { id: 'campaigns', label: 'Campaigns', href: `${base}/campaigns`, group: 'Go to' },
    { id: 'records', label: 'Records', href: `${base}/records`, group: 'Go to' },
    ...objectTypes.map((o) => ({
      id: `obj:${o.id}`,
      label: o.plural,
      hint: 'records',
      href: `${base}/records/${o.apiSlug}`,
      group: 'Go to' as const,
    })),
    { id: 'lists', label: 'Lists', href: `${base}/lists`, group: 'Go to' },
    ...lists.map((l) => ({
      id: `list:${l.id}`,
      label: l.name,
      hint: l.kind === 'PIPELINE' ? 'pipeline' : 'collection',
      href: `${base}/lists/${l.id}`,
      group: 'Go to' as const,
    })),
    ...objectTypes.map((o) => ({
      id: `new:${o.id}`,
      label: `New ${o.singular.toLowerCase()}`,
      href: `${base}/records/${o.apiSlug}/new`,
      group: 'Create' as const,
    })),
    { id: 'new-list', label: 'New list', href: `${base}/lists`, group: 'Create' },
    { id: 'invite', label: 'Invite a member', href: `${base}/settings/members`, group: 'Create' },
    {
      id: 's-general',
      label: 'Workspace settings',
      href: `${base}/settings/general`,
      group: 'Settings',
    },
    { id: 's-members', label: 'Members', href: `${base}/settings/members`, group: 'Settings' },
    {
      id: 's-objects',
      label: 'Objects & attributes',
      href: `${base}/settings/objects`,
      group: 'Settings',
    },
    { id: 's-audit', label: 'Audit log', href: `${base}/settings/audit`, group: 'Settings' },
  ];

  return (
    <TrpcProvider slug={workspace.slug}>
      <CommandPalette commands={commands} />
      <div className="flex h-dvh flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-5 border-b border-hairline bg-card px-4">
          <Link
            href={base}
            className="w-auto shrink-0 rounded-[var(--radius-control)] lg:w-[218px]"
          >
            <BrandMark />
          </Link>
          <GlobalSearch slug={workspace.slug} />
          <div className="flex shrink-0 items-center gap-4">
            <Link
              href={`${base}/follow-ups`}
              aria-label={
                counts.overdue > 0
                  ? `Notifications: ${counts.overdue} overdue follow-up${counts.overdue === 1 ? '' : 's'}`
                  : 'Notifications: nothing overdue'
              }
              className="relative grid size-9 place-items-center rounded-[var(--radius-control)] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <Bell aria-hidden size={19} />
              {counts.overdue > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0 grid min-w-[17px] place-items-center rounded-full bg-[#d92d43] px-1 text-[10px] font-semibold leading-[17px] text-white"
                >
                  {counts.overdue > 99 ? '99+' : counts.overdue}
                </span>
              ) : null}
            </Link>
            <UserMenu
              user={{ name: user.name, email: user.email }}
              role={workspace.role}
              currentSlug={workspace.slug}
              workspaces={workspaces.map((w) => ({
                id: w.id,
                name: w.name,
                slug: w.slug,
                role: w.role,
              }))}
              theme={theme}
            />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <Rail
            slug={workspace.slug}
            role={workspace.role}
            counts={counts}
            pipelineHref={pipelineHref}
          />
          <div className="min-w-0 flex-1 overflow-auto px-6 py-6">{children}</div>
        </div>
      </div>
    </TrpcProvider>
  );
}
