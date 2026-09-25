/**
 * Graph API plumbing: usage-header parsing (spec §8.1 "feed the budget store"), error-body
 * classification onto the §9.2 taxonomy (Meta reports expired tokens as HTTP 400 code 190),
 * cursor paging and the reserve/settle wrapper every call goes through.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import type { BudgetHandle, ConnCtx, HttpResponse, ObservedUsage } from '@nexus/connector-sdk';

// ─── usage headers ──────────────────────────────────────────────────────────

const appUsageSchema = z.object({
  call_count: z.number().optional(),
  total_cputime: z.number().optional(),
  total_time: z.number().optional(),
});
const bucUsageSchema = z.record(
  z.string(),
  z.array(
    z.object({
      type: z.string().optional(),
      call_count: z.number().optional(),
      total_cputime: z.number().optional(),
      total_time: z.number().optional(),
      estimated_time_to_regain_access: z.number().optional(),
    }),
  ),
);

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `X-App-Usage` / `X-Page-Usage` are `{call_count, total_cputime, total_time}` percentages of
 * the hourly pool; `X-Business-Use-Case-Usage` is the same per business id and use case, with
 * `estimated_time_to_regain_access` in minutes once a pool is exhausted. The highest percentage
 * across every pool is what the limiter backs off on (80%).
 */
export function parseUsageHeaders(
  headers: Readonly<Record<string, string>>,
  now: number,
): ObservedUsage {
  let percent = 0;
  let retryAfter: Date | undefined;
  const kept: Record<string, string> = {};
  for (const name of ['x-app-usage', 'x-page-usage']) {
    const parsed = appUsageSchema.safeParse(safeJson(headers[name]));
    if (parsed.success) {
      kept[name] = headers[name]!;
      percent = Math.max(
        percent,
        parsed.data.call_count ?? 0,
        parsed.data.total_cputime ?? 0,
        parsed.data.total_time ?? 0,
      );
    }
  }
  const buc = bucUsageSchema.safeParse(safeJson(headers['x-business-use-case-usage']));
  if (buc.success) {
    kept['x-business-use-case-usage'] = headers['x-business-use-case-usage']!;
    for (const entries of Object.values(buc.data)) {
      for (const e of entries) {
        percent = Math.max(percent, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0);
        if (e.estimated_time_to_regain_access && e.estimated_time_to_regain_access > 0) {
          const at = new Date(now + e.estimated_time_to_regain_access * 60_000);
          if (!retryAfter || at > retryAfter) retryAfter = at;
        }
      }
    }
  }
  const out: ObservedUsage = { headers: kept };
  if (Object.keys(kept).length) out.percentUsed = Math.min(100, Math.round(percent));
  if (retryAfter) out.retryAfter = retryAfter;
  return out;
}

// ─── error classification ───────────────────────────────────────────────────

export const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
    error_user_msg: z.string().optional(),
  }),
});

const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80007, 80008, 80009, 80014,
]);
const SCOPE_CODES = new Set([
  10, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218,
  219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237,
  238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256,
  257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275,
  276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294,
  295, 296, 297, 298, 299,
]);
const TRANSIENT_CODES = new Set([1, 2]);

/** Map a Graph error body (any HTTP status) to the taxonomy. Returns null when the body is not a Graph error. */
export function classifyGraphError(
  status: number,
  body: unknown,
  ctx: { platformName: string; connectionLabel?: string } = { platformName: 'Meta' },
): NexusError | null {
  const parsed = graphErrorSchema.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data.error;
  const details = {
    status,
    graphCode: e.code,
    graphSubcode: e.error_subcode,
    fbtraceId: e.fbtrace_id,
    graphMessage: e.message,
  };
  if (e.code === 190 || (e.type === 'OAuthException' && status === 401)) {
    return new NexusError('AUTH_EXPIRED', {
      message: e.message ?? 'access token invalid',
      context: ctx,
      details,
    });
  }
  if (e.code !== undefined && RATE_LIMIT_CODES.has(e.code)) {
    return new NexusError('RATE_LIMITED', {
      message: e.message ?? 'rate limited',
      context: { ...ctx, resumesAt: new Date(Date.now() + 15 * 60_000) },
      details,
    });
  }
  if (e.code !== undefined && SCOPE_CODES.has(e.code)) {
    return new NexusError('SCOPE_MISSING', {
      message: e.message ?? 'insufficient permission',
      context: ctx,
      details,
    });
  }
  if (e.code === 100 && e.error_subcode === 33) {
    return new NexusError('NOT_FOUND', {
      message: e.message ?? 'object not found',
      context: ctx,
      details,
    });
  }
  if (e.code === 100 || e.code === 803) {
    return new NexusError('VALIDATION', {
      message: e.message ?? 'invalid parameter',
      context: ctx,
      details,
    });
  }
  if ((e.code !== undefined && TRANSIENT_CODES.has(e.code)) || status >= 500) {
    return new NexusError('PLATFORM_DOWN', {
      message: e.message ?? 'platform error',
      context: ctx,
      details,
    });
  }
  return new NexusError('VALIDATION', {
    message: e.message ?? `Graph API error ${e.code ?? status}`,
    context: ctx,
    details,
  });
}

/** The HTTP client throws on 4xx before we see the body; re-classify from the captured text. */
export function rethrowGraph(
  e: unknown,
  ctx?: { platformName: string; connectionLabel?: string },
): never {
  if (
    e instanceof NexusError &&
    typeof e.details.status === 'number' &&
    typeof e.details.bodyText === 'string'
  ) {
    const classified = classifyGraphError(e.details.status, safeJson(e.details.bodyText), ctx);
    if (classified) throw classified;
  }
  throw e;
}

// ─── paging ─────────────────────────────────────────────────────────────────

export const pagingSchema = z
  .object({
    cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
    next: z.string().optional(),
    previous: z.string().optional(),
  })
  .optional();

export const listSchema = z.object({ data: z.array(z.unknown()), paging: pagingSchema });
export type GraphList = z.infer<typeof listSchema>;

/** Meta signals "more pages" with `paging.next`; the `after` cursor is the opaque token we persist. */
export function nextCursorOf(list: GraphList): string | null {
  return list.paging?.next && list.paging.cursors?.after ? list.paging.cursors.after : null;
}

// ─── calls ──────────────────────────────────────────────────────────────────

export type GraphCallResult<T> = { value: T; response: HttpResponse };

/**
 * Reserve → call → settle with observed usage, re-classifying Graph error bodies. `cost` is in
 * calls (the rolling-hour pool); the connector passes 2 for nested-field queries Meta charges
 * more for.
 */
export async function graphCall<T>(
  ctx: ConnCtx<unknown>,
  budget: BudgetHandle,
  endpoint: string,
  cost: number,
  call: () => Promise<HttpResponse>,
  parse: (json: unknown) => T,
): Promise<GraphCallResult<T>> {
  const r = await budget.reserve({ endpoint, cost });
  if (!r.ok) throw r.error;
  try {
    const response = await call().catch((e: unknown) =>
      rethrowGraph(e, { platformName: ctx.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook' }),
    );
    await budget.settle(r.value, {
      observed: parseUsageHeaders(response.headers, Date.now()),
      httpStatus: response.status,
    });
    return { value: parse(response.json()), response };
  } catch (e) {
    const status =
      e instanceof NexusError && typeof e.details.status === 'number'
        ? e.details.status
        : undefined;
    const retryAfter = e instanceof NexusError ? e.context.resumesAt : undefined;
    await budget.settle(r.value, {
      httpStatus: status,
      observed: retryAfter ? { retryAfter } : undefined,
    });
    throw e;
  }
}
