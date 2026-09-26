/**
 * The one wrapper every REST v1 route handler is built from, so the cross-cutting rules of
 * §11.2 are applied identically everywhere rather than remembered per route:
 *
 *   authenticate (bearer key + scope ladder)
 *     → consume the per-key rate window, and emit `X-RateLimit-*` on *every* response
 *     → on a write, honour `Idempotency-Key`: replay a stored response, or 409 on reuse with a
 *       different request, otherwise run the handler once and remember what it returned
 *     → funnel every throw into RFC 9457 Problem Details.
 *
 * `restRoute` hands the handler a `RestContext` with `withTenant` (one transaction, RLS set,
 * scoped client) and the raw `deps`, because some operations — a reply going through
 * `requestReply`, a sync enqueue — open their own transactions and must not nest.
 */

import {
  checkIdempotency,
  recordIdempotency,
  requestHashFor,
  writeAudit,
  type ApiKeyScope,
  type Actor,
  type AuditEntry,
  type TenantDb,
} from '@nexus/db';
import type { z } from 'zod';
import type { Authenticated } from './auth.ts';
import { authenticate } from './auth.ts';
import { getRestDeps, type RestDeps } from './deps.ts';
import { errorResponse, problem } from './problem.ts';
import { consume, rateLimitHeaders } from './rate-limit.ts';

export type RestResult = { status?: number; body: unknown };

export type RestContext = Authenticated & {
  deps: RestDeps;
  req: Request;
  url: URL;
  /** The parsed JSON body of a write, or `undefined` when there was none. */
  body: unknown;
  /** One transaction with `SET LOCAL app.workspace_id` and the tenant-scoped client. */
  withTenant<T>(fn: (db: TenantDb, actor: Actor) => Promise<T>): Promise<T>;
  /** §5.4: a REST write is audited the same way a tRPC mutation is. */
  audit(db: TenantDb, entry: AuditEntry): Promise<void>;
  /** Validate a JSON body, turning a Zod failure into a 400 Problem Details response. */
  parse<S extends z.ZodType>(schema: S): z.infer<S>;
  /** Validate the query string the same way. */
  query<S extends z.ZodType>(schema: S): z.infer<S>;
};

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export type RouteHandler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

function jsonResponse(result: RestResult, headers: Record<string, string>): Response {
  const status = result.status ?? 200;
  if (result.body === undefined || status === 204) {
    return new Response(null, { status: 204, headers });
  }
  return new Response(JSON.stringify(result.body), {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

export function restRoute<P = Record<string, never>>(
  requiredScope: ApiKeyScope,
  handler: (ctx: RestContext, params: P) => Promise<RestResult>,
): RouteHandler<P> {
  return async (req, routeCtx) => {
    let deps: RestDeps;
    try {
      deps = await getRestDeps();
    } catch (e) {
      return errorResponse(e);
    }

    const authResult = await authenticate(deps, req, requiredScope);
    if (!authResult.ok) return authResult.response;
    const auth = authResult.auth;

    const verdict = consume(auth.apiKeyId, auth.rateLimitPerMinute);
    const headers = rateLimitHeaders(verdict);
    if (!verdict.allowed) {
      return problem(
        'RATE_LIMITED',
        `This key allows ${verdict.limit} requests per minute. Retry in ${verdict.retryAfterSeconds}s.`,
        { ...headers, 'retry-after': String(verdict.retryAfterSeconds) },
      );
    }

    const url = new URL(req.url);
    const isWrite = WRITE_METHODS.has(req.method.toUpperCase());
    let rawBody = '';
    if (isWrite) {
      try {
        rawBody = await req.text();
      } catch {
        rawBody = '';
      }
    }

    const idempotencyKey = isWrite ? req.headers.get('idempotency-key')?.trim() || null : null;
    const ref = idempotencyKey
      ? {
          workspaceId: auth.workspaceId,
          apiKeyId: auth.apiKeyId,
          key: idempotencyKey,
          requestHash: requestHashFor({
            method: req.method,
            path: url.pathname,
            body: rawBody,
          }),
        }
      : null;

    try {
      if (ref) {
        const hit = await deps.runtime.withTenant(auth.actor, (db) => checkIdempotency(db, ref));
        if (hit) {
          return new Response(hit.body === null ? null : JSON.stringify(hit.body), {
            status: hit.status,
            headers: {
              ...headers,
              'idempotency-replayed': 'true',
              ...(hit.body === null ? {} : { 'content-type': 'application/json' }),
            },
          });
        }
      }

      let parsedBody: unknown;
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          return problem('VALIDATION', 'The request body is not valid JSON.', headers);
        }
      }

      const ctx: RestContext = {
        ...auth,
        deps,
        req,
        url,
        body: parsedBody,
        withTenant: (fn) => deps.runtime.withTenant(auth.actor, (db) => fn(db, auth.actor)),
        audit: (db, entry) => writeAudit(db, auth.actor, entry),
        parse: (schema) => schema.parse(parsedBody ?? {}),
        query: (schema) => schema.parse(Object.fromEntries(url.searchParams)),
      };

      const result = await handler(ctx, await routeCtx.params);
      const status = result.status ?? 200;
      if (ref && status >= 200 && status < 300) {
        await deps.runtime.withTenant(auth.actor, (db) =>
          recordIdempotency(db, ref, status, result.body ?? null),
        );
      }
      return jsonResponse(result, headers);
    } catch (e) {
      return errorResponse(e, headers);
    }
  };
}
