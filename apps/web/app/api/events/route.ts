/**
 * Server-Sent Events for the inbox and timeline (spec §4 realtime, §12.2.A): one stream per
 * browser tab, filtered to the workspace the caller is a member of. Events carry ids and a
 * topic; the client refetches what changed. `GET /api/events?workspace=<slug>`.
 */
import { subscribeEvents, tenancy } from '@nexus/db';
import { sessionUserFromAuth } from '@/server/context';

export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('workspace');
  if (!slug) return new Response('workspace required', { status: 400 });
  const user = await sessionUserFromAuth();
  if (!user) return new Response('Unauthorized', { status: 401 });
  const resolved = await tenancy.resolveActor(user.id, slug, { ip: null, userAgent: null });
  if (!resolved) return new Response('Not found', { status: 404 });
  const workspaceId = resolved.workspaceId;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* closed */
        }
      };
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ workspaceId })}\n\n`);
      unsubscribe = await subscribeEvents(
        (e) => send(`event: ${e.topic}\ndata: ${JSON.stringify(e)}\n\n`),
        { workspaceId },
      );
      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      req.signal.addEventListener('abort', () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
