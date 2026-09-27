import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CommandPalette, type PaletteCommand } from '@/components/command-palette';
import { GlobalSearch } from '@/components/global-search';
import { TrpcProvider } from '@/lib/trpc-client';
import { Rail, RAIL_COOKIE } from '@/components/rail';
import { SignOutButton } from '@/components/sign-out-button';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { api } from '@/lib/api';
import { requireSessionUser } from '@/lib/session';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * The app shell (§12.1): a slim workspace bar under the global header, the left rail and the
 * content pane. The global header (brand + theme toggle) lives in app/layout.tsx and is not
 * repeated here. Negative margins let the shell fill the width and height of `<main>`.
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
  const [workspaces, cookieStore, objectTypes, lists] = await Promise.all([
    (await api()).workspace.list(),
    cookies(),
    client.objectType.list().catch(() => []),
    client.list.list().catch(() => []),
  ]);
  const railCollapsed = cookieStore.get(RAIL_COOKIE)?.value === 'collapsed';
  const base = `/w/${workspace.slug}`;
  const commands: PaletteCommand[] = [
    { id: 'home', label: 'Home', href: base, group: 'Go to' },
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
      <div className="-mx-4 -my-8 flex min-h-[calc(100dvh-3rem)] flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-hairline px-3">
          <WorkspaceSwitcher
            current={{ name: workspace.name, slug: workspace.slug, role: workspace.role }}
            workspaces={workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              slug: w.slug,
              role: w.role,
            }))}
          />
          <GlobalSearch slug={workspace.slug} />
          <div className="flex min-w-0 items-center gap-3">
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-[var(--text-sm)] font-medium leading-tight">
                {user.name ?? user.email}
              </p>
              {user.name ? (
                <p className="truncate text-[var(--text-xs)] leading-tight text-ink-muted">
                  {user.email}
                </p>
              ) : null}
            </div>
            <SignOutButton />
          </div>
        </div>
        <div className="flex flex-1">
          <Rail slug={workspace.slug} role={workspace.role} initialCollapsed={railCollapsed} />
          <div className="min-w-0 flex-1 px-6 py-6">{children}</div>
        </div>
      </div>
    </TrpcProvider>
  );
}
