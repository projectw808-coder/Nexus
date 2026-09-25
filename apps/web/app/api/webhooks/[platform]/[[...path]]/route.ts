/**
 * Inbound platform webhooks (spec §11.3): `POST /api/webhooks/:platform[/:connectionId]`.
 * Verify the signature over the raw bytes → persist the event → enqueue → 200, with no
 * business logic in the handler. `GET` answers Meta-style subscription challenges when the
 * verify token matches the app's configured one.
 */
import { loadEnv } from '@nexus/config';
import { PLATFORMS, type Platform } from '@nexus/connector-sdk';
import { receiveWebhook } from '@nexus/sync';
import { getSyncDeps } from '@/server/sync';

export const dynamic = 'force-dynamic';

function platformOf(param: string): Platform | null {
  const p = param.toUpperCase();
  return (PLATFORMS as readonly string[]).includes(p) ? (p as Platform) : null;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ platform: string; path?: string[] }> },
): Promise<Response> {
  const { platform } = await ctx.params;
  if (!platformOf(platform)) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  // Meta hub challenge: echo hub.challenge when the verify token matches.
  if (url.searchParams.get('hub.mode') === 'subscribe') {
    const env = loadEnv();
    const expected = env.META_WEBHOOK_VERIFY_TOKEN;
    if (expected && url.searchParams.get('hub.verify_token') === expected) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response('Forbidden', { status: 403 });
  }
  return new Response('Method not allowed', { status: 405 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ platform: string; path?: string[] }> },
): Promise<Response> {
  const { platform: platformParam, path } = await ctx.params;
  const platform = platformOf(platformParam);
  if (!platform) return new Response('Not found', { status: 404 });
  const rawBody = new Uint8Array(await req.arrayBuffer());
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const url = new URL(req.url);
  const deps = await getSyncDeps();
  const outcome = await receiveWebhook(deps, platform, {
    method: 'POST',
    path: `/api/webhooks/${platformParam}${path?.length ? `/${path.join('/')}` : ''}`,
    headers,
    rawBody,
    query: Object.fromEntries(url.searchParams),
  });
  const body =
    'eventId' in outcome
      ? { ok: outcome.status === 200, eventId: outcome.eventId }
      : { ok: false, reason: outcome.reason };
  return Response.json(body, { status: outcome.status });
}
