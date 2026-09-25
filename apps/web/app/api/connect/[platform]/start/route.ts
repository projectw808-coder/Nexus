/**
 * Start connecting a platform (spec §7.1 auth): `GET /api/connect/:platform/start?workspace=<slug>&returnTo=<path>`.
 * Mints the signed state and a PKCE pair, keeps the verifier in an httpOnly cookie keyed by
 * the state nonce, and redirects to the platform's authorization page.
 */
import { PLATFORMS, type Platform } from '@nexus/connector-sdk';
import { startOauth } from '@nexus/sync';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { getSyncDeps } from '@/server/sync';
import { serverCaller } from '@/server/context';

export const dynamic = 'force-dynamic';
export const OAUTH_COOKIE = 'nexus.oauth';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform: param } = await ctx.params;
  const platform = param.toUpperCase();
  if (!(PLATFORMS as readonly string[]).includes(platform))
    return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  const slug = url.searchParams.get('workspace');
  const returnTo =
    url.searchParams.get('returnTo') ?? (slug ? `/w/${slug}/settings/integrations` : '/');
  const user = await getSessionUser();
  if (!user)
    return NextResponse.redirect(
      new URL(`/sign-in?callbackUrl=${encodeURIComponent(url.pathname + url.search)}`, url.origin),
      303,
    );
  if (!slug) return new Response('workspace required', { status: 400 });

  // Membership + configure permission are enforced by the tRPC procedure; a non-member gets 404 there.
  const caller = await serverCaller({ headers: req.headers, slug });
  const workspace = await caller.workspace.current();
  const deps = await getSyncDeps();
  const start = startOauth(deps, {
    workspaceId: workspace.id,
    userId: user.id,
    platform: platform as Platform,
    returnTo: returnTo.startsWith('/') ? returnTo : '/',
  });

  const jar = await cookies();
  jar.set(
    `${OAUTH_COOKIE}.${start.nonce}`,
    JSON.stringify({ verifier: start.verifier, state: start.state }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/api/connect',
      maxAge: 600,
    },
  );
  return NextResponse.redirect(start.authorizeUrl, 303);
}
