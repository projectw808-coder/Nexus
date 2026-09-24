import { loadEnv } from '@nexus/config';
import { authAdapter } from '@nexus/db';
import { NextResponse } from 'next/server';

/**
 * Test-only sign-in (ADR-012): creates a database session for `?email=` and sets the Auth.js
 * cookie, so Playwright can act as a user without a mailbox. Honoured only when
 * E2E_AUTH_BYPASS=true (the e2e runner sets it for its own `next start`; production deployments
 * never set it and the env schema defaults it to false). Otherwise 404 like any unknown route.
 */
export async function GET(req: Request): Promise<Response> {
  const env = loadEnv();
  if (!env.E2E_AUTH_BYPASS) {
    return new Response('Not found', { status: 404 });
  }
  const url = new URL(req.url);
  const email = url.searchParams.get('email')?.trim().toLowerCase();
  const next = url.searchParams.get('next') ?? '/';
  if (!email) return new Response('email required', { status: 400 });

  const adapter = authAdapter();
  const user =
    (await adapter.getUserByEmail!(email)) ??
    (await adapter.createUser!({
      id: crypto.randomUUID(),
      email,
      emailVerified: new Date(),
      name: email.split('@')[0] ?? email,
    }));
  const token = crypto.randomUUID();
  await adapter.createSession!({
    sessionToken: token,
    userId: user.id,
    expires: new Date(Date.now() + 24 * 3600_000),
  });

  const secure = url.protocol === 'https:';
  const res = NextResponse.redirect(new URL(next.startsWith('/') ? next : '/', url.origin), 303);
  res.cookies.set(`${secure ? '__Secure-' : ''}authjs.session-token`, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 24 * 3600,
  });
  return res;
}
