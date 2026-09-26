/**
 * Drive the real REST v1 route handlers in-process, over a PGlite database (ADR-008).
 *
 * Next.js resolves `app/api/v1/**` by file path and hands each handler a `Request` plus a
 * promise of its path params. This harness does the same resolution against the same modules —
 * static segments before dynamic ones, exactly as the App Router orders them — so a test
 * exercises the shipped handler, its auth, its rate window and its idempotency, not a copy.
 */
import { createApiKey, type ApiKeyScope, type TenantDb } from '@nexus/db';
import { setRestDeps } from '@/app/api/v1/_lib/deps';
import { resetRateLimits } from '@/app/api/v1/_lib/rate-limit';
import type { Seed } from './testing';

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type Module = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', Handler | (() => Response)>>;

/**
 * Path segments; `[name]` is a parameter. The order here is irrelevant — matching is by shape.
 *
 * The modules are loaded as `unknown`: each handler is typed for *its own* params object, and
 * those types are mutually incompatible when collected into one table. Next.js erases the same
 * distinction at runtime; the cast at the call site is where that is admitted.
 */
const ROUTES: { segments: string[]; load: () => Promise<unknown> }[] = [
  { segments: ['openapi.json'], load: () => import('@/app/api/v1/openapi.json/route') },
  { segments: ['objects'], load: () => import('@/app/api/v1/objects/route') },
  {
    segments: ['objects', '[slug]', 'records'],
    load: () => import('@/app/api/v1/objects/[slug]/records/route'),
  },
  {
    segments: ['objects', '[slug]', 'records', 'query'],
    load: () => import('@/app/api/v1/objects/[slug]/records/query/route'),
  },
  {
    segments: ['objects', '[slug]', 'records', '[id]'],
    load: () => import('@/app/api/v1/objects/[slug]/records/[id]/route'),
  },
  {
    segments: ['lists', '[id]', 'entries'],
    load: () => import('@/app/api/v1/lists/[id]/entries/route'),
  },
  {
    segments: ['people', '[id]', 'timeline'],
    load: () => import('@/app/api/v1/people/[id]/timeline/route'),
  },
  { segments: ['conversations'], load: () => import('@/app/api/v1/conversations/route') },
  {
    segments: ['conversations', '[id]', 'messages'],
    load: () => import('@/app/api/v1/conversations/[id]/messages/route'),
  },
  { segments: ['connections'], load: () => import('@/app/api/v1/connections/route') },
  {
    segments: ['connections', '[id]', 'health'],
    load: () => import('@/app/api/v1/connections/[id]/health/route'),
  },
  {
    segments: ['connections', '[id]', 'sync'],
    load: () => import('@/app/api/v1/connections/[id]/sync/route'),
  },
  {
    segments: ['connections', '[id]', 'pause'],
    load: () => import('@/app/api/v1/connections/[id]/pause/route'),
  },
  {
    segments: ['connections', '[id]', 'resume'],
    load: () => import('@/app/api/v1/connections/[id]/resume/route'),
  },
  {
    segments: ['connections', '[id]', 'runs'],
    load: () => import('@/app/api/v1/connections/[id]/runs/route'),
  },
  {
    segments: ['connections', '[id]', 'runs', '[runId]', 'replay'],
    load: () => import('@/app/api/v1/connections/[id]/runs/[runId]/replay/route'),
  },
  { segments: ['search'], load: () => import('@/app/api/v1/search/route') },
];

function match(
  pathSegments: string[],
): { route: (typeof ROUTES)[number]; params: Record<string, string> } | null {
  const candidates = ROUTES.filter((r) => r.segments.length === pathSegments.length).filter((r) =>
    r.segments.every((s, i) => s.startsWith('[') || s === pathSegments[i]),
  );
  if (candidates.length === 0) return null;
  // The App Router prefers a static segment over a dynamic one; fewest parameters wins.
  const best = candidates.reduce((a, b) =>
    a.segments.filter((s) => s.startsWith('[')).length <=
    b.segments.filter((s) => s.startsWith('[')).length
      ? a
      : b,
  );
  const params: Record<string, string> = {};
  best.segments.forEach((s, i) => {
    if (s.startsWith('[')) params[s.slice(1, -1)] = pathSegments[i]!;
  });
  return { route: best, params };
}

export const REST_ORIGIN = 'http://rest.test';
export const REST_BASE_URL = `${REST_ORIGIN}/api`;

export type RestHarness = {
  /** A `fetch` that reaches the route handlers. Pass it to a generated OpenAPI client. */
  fetch: typeof fetch;
  /** Mint a key and hand back its plaintext. */
  createKey(opts?: {
    name?: string;
    scopes?: ApiKeyScope[];
    rateLimitPerMinute?: number | null;
    expiresAt?: Date | null;
    workspaceId?: string;
  }): Promise<{ id: string; plaintext: string; prefix: string }>;
  /** A JSON request with a bearer key, returning status, parsed body and headers. */
  call(
    method: string,
    path: string,
    opts?: { key?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown; headers: Headers }>;
  dispose(): void;
};

export function restHarness(seed: Seed): RestHarness {
  setRestDeps({ runtime: seed.db.runtime, sync: seed.sync, jobs: seed.jobs });
  resetRateLimits();

  const dispatch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'v1') {
      return new Response('Not found', { status: 404 });
    }
    const found = match(parts.slice(2));
    if (!found) return new Response('Not found', { status: 404 });
    const mod = (await found.route.load()) as Module;
    const handler = mod[request.method.toUpperCase() as 'GET'];
    if (!handler) return new Response('Method not allowed', { status: 405 });
    return (handler as Handler)(request, { params: Promise.resolve(found.params) });
  };

  return {
    fetch: dispatch,
    async createKey(opts = {}) {
      const workspaceId = opts.workspaceId ?? seed.acme.id;
      const actor = {
        workspaceId,
        userId: seed.users.alice.id,
        role: 'OWNER' as const,
        grants: [],
      };
      return seed.db.runtime.withTenant(actor, (db: TenantDb) =>
        createApiKey(db, actor, {
          name: opts.name ?? 'test key',
          scopes: opts.scopes ?? ['READ', 'WRITE'],
          rateLimitPerMinute: opts.rateLimitPerMinute ?? null,
          expiresAt: opts.expiresAt ?? null,
        }),
      );
    },
    async call(method, path, opts = {}) {
      const res = await dispatch(`${REST_ORIGIN}${path}`, {
        method,
        headers: {
          ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, body, headers: res.headers };
    },
    dispose() {
      setRestDeps(null);
      resetRateLimits();
    },
  };
}
