import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { RoleBadge } from '@/components/role-badge';
import { api } from '@/lib/api';
import { formatDate, isoOf } from '@/lib/format';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) redirect('/sign-in');

  const client = await api();
  const workspaces = await client.workspace.list();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workspaces"
        description={`Signed in as ${user.name ?? user.email}.`}
        actions={
          <LinkButton href="/new" variant="primary">
            New workspace
          </LinkButton>
        }
      />

      {workspaces.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="A workspace holds your records, conversations and integrations. Create one, or accept an invitation from a colleague."
          action={
            <LinkButton href="/new" variant="primary">
              Create your first workspace
            </LinkButton>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              <Link
                href={`/w/${w.slug}`}
                className="flex h-full flex-col justify-between gap-4 rounded-[var(--radius-card)] border border-hairline bg-card p-4 transition-colors duration-[var(--duration-state)] hover:border-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[var(--text-md)] font-semibold tracking-tight">
                      {w.name}
                    </p>
                    <p className="truncate font-mono text-[var(--text-xs)] text-ink-muted">
                      /w/{w.slug}
                    </p>
                  </div>
                  <RoleBadge role={w.role} />
                </div>
                <p className="text-[var(--text-xs)] text-ink-muted">
                  {w.joinedAt ? (
                    <>
                      Joined <time dateTime={isoOf(w.joinedAt)}>{formatDate(w.joinedAt)}</time>
                    </>
                  ) : (
                    'Member'
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[var(--text-sm)] text-ink-muted">
        Looking for the infrastructure checks?{' '}
        <Link href="/status" className="text-link underline-offset-2 hover:underline">
          System status
        </Link>
        .
      </p>
    </div>
  );
}
