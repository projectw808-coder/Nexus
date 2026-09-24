import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { getWorkspace } from '@/lib/workspace';

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const { q } = await searchParams;
  const workspace = await getWorkspace(slug);
  const query = (q ?? '').trim();

  if (!query) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Search"
          description="Find people, companies, deals and any custom object by any text value."
        />
        <EmptyState
          title="Type something in the search box"
          description="Results are grouped by object and link to the record."
        />
      </div>
    );
  }

  let result;
  try {
    result = await (await api(workspace.slug)).search.global({ q: query, limitPerObject: 10 });
  } catch (e) {
    if (isCode(e, 'FORBIDDEN'))
      return (
        <PermissionDenied
          title="Search is closed to your role"
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    throw e;
  }
  const total = result.groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={<>Results for “{query}”</>}
        description={`${total} ${total === 1 ? 'match' : 'matches'}${result.groups.some((g) => g.more) ? ', showing the first 10 per object' : ''}.`}
      />
      {result.groups.length === 0 ? (
        <EmptyState
          title="Nothing matched"
          description="Try fewer words, or a name as it appears on the record."
        />
      ) : (
        result.groups.map((g) => (
          <section
            key={g.objectType.id}
            aria-labelledby={`search-${g.objectType.apiSlug}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`search-${g.objectType.apiSlug}`}
              className="text-[var(--text-md)] font-semibold tracking-tight"
            >
              {g.objectType.plural}{' '}
              <span className="tnum font-normal text-ink-muted">
                ({g.items.length}
                {g.more ? '+' : ''})
              </span>
            </h2>
            <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
              {g.items.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/w/${workspace.slug}/records/${g.objectType.apiSlug}/${r.id}`}
                    className="block px-4 py-2 text-[var(--text-sm)] hover:bg-raised"
                  >
                    <span className="font-medium">{r.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {g.more ? (
              <Link
                href={`/w/${workspace.slug}/records/${g.objectType.apiSlug}?q=${encodeURIComponent(query)}`}
                className="text-[var(--text-sm)] text-link hover:underline"
              >
                All matching {g.objectType.plural.toLowerCase()} →
              </Link>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}
