import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { GlobalSearch } from '@/components/global-search';
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
  const [workspaces, cookieStore] = await Promise.all([(await api()).workspace.list(), cookies()]);
  const railCollapsed = cookieStore.get(RAIL_COOKIE)?.value === 'collapsed';

  return (
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
        <Rail slug={workspace.slug} initialCollapsed={railCollapsed} />
        <div className="min-w-0 flex-1 px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
