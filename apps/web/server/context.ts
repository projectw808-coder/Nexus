/**
 * Builds the tRPC context for HTTP requests (`/api/trpc`) and for in-process callers used by
 * server components and server actions. The session comes from Auth.js; the workspace slug
 * comes from the `x-nexus-workspace` header or is passed explicitly by server code.
 */
import { loadEnv } from '@nexus/config';
import { runtime, tenancy } from '@nexus/db';
import { auth } from '@/auth';
import { getMailProvider } from '@/lib/mail/provider';
import { appRouter } from './routers';
import { createCallerFactory, type Context, type SessionUser } from './trpc';

export const WORKSPACE_HEADER = 'x-nexus-workspace';

export async function sessionUserFromAuth(): Promise<SessionUser | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id || !u.email) return null;
  return { id: u.id, email: u.email, name: u.name ?? null };
}

function requestMeta(headers: Headers): { ip: string | null; userAgent: string | null } {
  const forwarded = headers.get('x-forwarded-for');
  return {
    ip: forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : (headers.get('x-real-ip') ?? null),
    userAgent: headers.get('user-agent'),
  };
}

export async function createContext(opts: {
  headers: Headers;
  slug?: string | null;
}): Promise<Context> {
  const env = loadEnv();
  const session = await sessionUserFromAuth();
  return {
    session,
    slug: opts.slug ?? opts.headers.get(WORKSPACE_HEADER),
    ...requestMeta(opts.headers),
    runtime,
    tenancy,
    mail: getMailProvider(),
    appUrl: env.APP_URL,
  };
}

const callerFactory = createCallerFactory(appRouter);

/** In-process caller for RSC loaders and server actions. */
export async function serverCaller(opts: { headers: Headers; slug?: string | null }) {
  return callerFactory(await createContext(opts));
}
