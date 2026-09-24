/**
 * Resolves the current workspace for a `/w/[slug]` segment. Wrapped in React `cache` so the
 * layout and the page under it share one `workspace.current()` call per request. Signed-out
 * users are sent to sign-in; non-members (and unknown slugs) get the 404 — the API does not
 * distinguish them, on purpose.
 */
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

export const getWorkspace = cache(async (slug: string) => {
  await requireSessionUser();
  const client = await api(slug);
  try {
    return await client.workspace.current();
  } catch (e) {
    if (isCode(e, 'NOT_FOUND', 'BAD_REQUEST')) notFound();
    throw e;
  }
});

export type CurrentWorkspace = Awaited<ReturnType<typeof getWorkspace>>;
