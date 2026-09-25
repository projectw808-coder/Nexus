/**
 * OAuth callback: `GET /api/connect/:platform/callback?code=&state=`. Verifies the signed
 * state, exchanges the code (with the PKCE verifier from the start cookie), attaches every
 * discovered account as a Connection and queues its backfill, then returns the user to where
 * they started. Errors land on the integrations page as a query parameter, never as a stack.
 */
import { NexusError } from '@nexus/core';
import { completeOauth, connectPlatform } from '@nexus/sync';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { serverCaller } from '@/server/context';
import { getSyncDeps } from '@/server/sync';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform: param } = await ctx.params;
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL('/sign-in', url.origin), 303);
  const fail = (reason: string, returnTo = '/') =>
    NextResponse.redirect(
      new URL(
        `${returnTo}${returnTo.includes('?') ? '&' : '?'}connectError=${encodeURIComponent(reason)}`,
        url.origin,
      ),
      303,
    );
  if (!code || !state)
    return fail(
      url.searchParams.get('error_description') ??
        url.searchParams.get('error') ??
        'The platform did not return an authorization code.',
    );

  const nonce = (() => {
    try {
      const body = state.split('.')[0] ?? '';
      return (
        (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { nonce?: string }).nonce ??
        ''
      );
    } catch {
      return '';
    }
  })();
  const jar = await cookies();
  const cookieName = `nexus.oauth.${nonce}`;
  const raw = jar.get(cookieName)?.value;
  const stored = raw ? (JSON.parse(raw) as { verifier?: string; state?: string }) : null;
  jar.delete({ name: cookieName, path: '/api/connect' });
  if (!stored || stored.state !== state)
    return fail('This sign-in attempt has expired. Start the connection again.');

  const deps = await getSyncDeps();
  try {
    const done = await completeOauth(deps, { code, state, verifier: stored.verifier });
    if (done.userId !== user.id) return fail('This connection was started by a different user.');
    // Resolve the actor through the tRPC context so role and grants are the real ones.
    const caller = await serverCaller({ headers: req.headers, slug: null });
    const workspaces = await caller.workspace.list();
    const ws = workspaces.find((w) => w.id === done.workspaceId);
    if (!ws) return fail('You are no longer a member of that workspace.', done.returnTo);
    const actor = {
      workspaceId: ws.id,
      userId: user.id,
      role: ws.role,
      grants: [] as const,
      actorType: 'USER' as const,
    };
    const result = await connectPlatform(deps, {
      actor,
      platform: done.platform,
      token: done.token,
    });
    const target = new URL(done.returnTo, url.origin);
    target.searchParams.set('connected', String(result.connections.length));
    return NextResponse.redirect(target, 303);
  } catch (e) {
    const message = e instanceof NexusError ? e.userMessage : 'Connecting failed. Try again.';
    deps.logger.warn('oauth callback failed', {
      platform: param,
      error: e instanceof Error ? e.message : String(e),
    });
    return fail(message);
  }
}
