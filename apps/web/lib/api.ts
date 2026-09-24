/**
 * The in-process tRPC caller for server components and server actions. Every screen goes
 * through this — there is no client-side tRPC in Phase 1.
 */
import { headers } from 'next/headers';
import { serverCaller } from '@/server/context';

export async function api(slug?: string | null) {
  return serverCaller({ headers: await headers(), slug: slug ?? null });
}

export type Api = Awaited<ReturnType<typeof api>>;
