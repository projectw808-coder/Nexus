/**
 * Session helpers for server components, route handlers and server actions.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';

export type SessionUser = { id: string; email: string; name: string | null };

/** The signed-in user, or null. Never throws. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/**
 * The signed-in user, or a redirect to `/sign-in?callbackUrl=<current path>`. The current path
 * comes from an `x-pathname` header when a proxy/middleware sets one; otherwise `/`.
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user) return user;
  const pathname = (await headers()).get('x-pathname') ?? '/';
  redirect(`/sign-in?callbackUrl=${encodeURIComponent(pathname)}`);
}
