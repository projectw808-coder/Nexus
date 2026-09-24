'use server';

import type { SearchResult } from '@/components/record-search';
import { api } from '@/lib/api';
import { messageOf } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

/**
 * Server-driven record search for pickers (relationship inputs, "add to list"). Bound with the
 * workspace slug and the target object (apiSlug or id) before it is handed to a client island.
 */
export async function searchRecordsAction(
  slug: string,
  objectTypeRef: string,
  q: string,
): Promise<SearchResult> {
  await requireSessionUser();
  const term = q.trim().slice(0, 200);
  if (!term) return { ok: true, items: [] };
  try {
    const client = await api(slug);
    const r = await client.record.query({
      objectType: objectTypeRef,
      query: { filters: [], sort: [], search: term, limit: 10, includeDeleted: false },
    });
    return { ok: true, items: r.items.map((i) => ({ id: i.id, label: i.label })) };
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  }
}
