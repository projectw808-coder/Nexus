/**
 * E2E-only: the in-process mock platform's HTTP face (`/api/e2e/mock/...`). Serves the
 * platform's API and OAuth token endpoint from `createMockPlatform().handle`, answers the
 * browser's authorization redirect itself, and exposes `POST …/mock/_emit` to fire an inbound
 * comment webhook. 404 unless E2E_AUTH_BYPASS is on.
 */
import { findConnectionForWebhook, runtime } from '@nexus/db';
import { NextResponse } from 'next/server';
import { e2eMockLog, getE2eMock, logMock } from '@/server/e2e-mock';

export const dynamic = 'force-dynamic';

async function serve(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const mock = getE2eMock();
  if (!mock) return new Response('Not found', { status: 404 });
  const { path = [] } = await ctx.params;
  const url = new URL(req.url);
  const subpath = `/${path.join('/')}`;

  // The browser lands here from /api/connect/mock/start; send it back with a code.
  if (req.method === 'GET' && subpath === '/oauth/authorize') {
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    const scope = url.searchParams.get('scope') ?? 'read:posts read:comments write:reply_comment';
    if (!redirect) return new Response('redirect_uri required', { status: 400 });
    const back = new URL(redirect);
    back.searchParams.set('code', `code-e2e-${Date.now()}?scope=${scope}`);
    back.searchParams.set('state', state);
    return NextResponse.redirect(back, 303);
  }
  if (req.method === 'GET' && subpath === '/_stats') {
    return NextResponse.json({ stats: mock.stats, recent: e2eMockLog() });
  }
  if (req.method === 'POST' && subpath === '/_emit') {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string; text?: string };
    const accountId = body.accountId ?? mock.accounts[0]!.id;
    // The connector subscribed with a per-connection secret, so the webhook is delivered to
    // that connection's path — exactly what the platform would do with the registered URL.
    const connection = await findConnectionForWebhook(runtime, {
      platform: 'MOCK',
      accountExternalId: accountId,
    });
    const result = await mock.newComment(
      accountId,
      body.text,
      connection ? `/api/webhooks/mock/${connection.id}` : undefined,
      // Unique per emit: this instance restarts with the server, the database does not.
      `comment_e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    );
    return NextResponse.json({
      ok: true,
      comment: result.comment,
      webhook: result.webhook.deliveryId,
    });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const res = await mock.handle({
    method: req.method,
    path: subpath,
    query: Object.fromEntries(url.searchParams.entries()),
    headers,
    body: bodyText,
  });
  logMock(
    `${req.method} ${subpath} ${(headers['authorization'] ?? '-').slice(0, 24)} -> ${res.status}${res.status >= 400 ? ` ${res.body.slice(0, 120)}` : ''}`,
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
