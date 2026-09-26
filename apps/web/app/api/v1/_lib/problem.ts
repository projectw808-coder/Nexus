/**
 * RFC 9457 Problem Details — the single error vocabulary of REST v1 (§11.2).
 *
 * There is no second error taxonomy here: a `NexusError` already carries the class, the HTTP
 * status, the sentence to show a human and the remediation (§9.2, `packages/core/src/errors.ts`),
 * so the mapping is a projection of `FAILURE_TAXONOMY` onto Problem Details fields, never a new
 * set of codes. `Content-Type` is always `application/problem+json`.
 */
import { NexusError, type FailureClass } from '@nexus/core';
import { TenantScopeError } from '@nexus/db';
import type { Problem } from '@nexus/api';
import { z } from 'zod';

/** Problem `type` URIs are stable identifiers, one per failure class. */
export const PROBLEM_TYPE_BASE = 'https://nexuscrm.dev/problems/';

const TITLES: Record<FailureClass, string> = {
  AUTH_EXPIRED: 'Authentication expired',
  SCOPE_MISSING: 'Missing scope',
  RATE_LIMITED: 'Rate limited',
  QUOTA_EXHAUSTED: 'Quota exhausted',
  PLATFORM_DOWN: 'Upstream platform unavailable',
  SCHEMA_DRIFT: 'Unprocessable payload',
  POLICY_BLOCKED: 'Blocked by policy',
  DUPLICATE: 'Duplicate',
  VALIDATION: 'Invalid request',
  NOT_FOUND: 'Not found',
  FORBIDDEN: 'Forbidden',
  CONFLICT: 'Conflict',
  INTERNAL: 'Internal error',
};

export function problemTypeFor(code: FailureClass): string {
  return `${PROBLEM_TYPE_BASE}${code.toLowerCase().replaceAll('_', '-')}`;
}

export function problemResponse(body: Problem, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { ...(headers ?? {}), 'content-type': 'application/problem+json' },
  });
}

/** Build a Problem body from a taxonomy class, so the sentence a human reads is the §9.2 one. */
export function problemFor(code: FailureClass, detail?: string, extra?: Partial<Problem>): Problem {
  const e = new NexusError(code, detail ? { context: { reason: detail } } : {});
  return {
    type: problemTypeFor(code),
    title: TITLES[code],
    status: e.httpStatus,
    detail: detail ?? (e.userMessage || TITLES[code]),
    code,
    remediation: e.remediation,
    ...extra,
  };
}

export function problem(code: FailureClass, detail?: string, headers?: HeadersInit): Response {
  return problemResponse(problemFor(code, detail), headers);
}

function fromZodError(e: z.ZodError): Problem {
  return {
    ...problemFor('VALIDATION', 'The request body or query string did not validate.'),
    errors: e.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
  };
}

/**
 * The one funnel every route's `catch` goes through. A `TenantScopeError` is a programming
 * error, never a caller error, so it is reported as a plain 500 with no internals leaked.
 */
export function problemFromError(e: unknown): Problem {
  if (e instanceof z.ZodError) return fromZodError(e);
  if (NexusError.is(e)) {
    // A DUPLICATE is a taxonomy no-op (httpStatus 200); over REST that has to be a real failure.
    const status = e.httpStatus >= 400 ? e.httpStatus : 409;
    return {
      type: problemTypeFor(e.code),
      title: TITLES[e.code],
      status,
      detail: e.userMessage || e.message,
      code: e.code,
      // `context.detail` is how the taxonomy already lets a thrower supply the remediation
      // sentence (POLICY_BLOCKED and VALIDATION read it directly); classes whose remediation is
      // a constant — CONFLICT, NOT_FOUND — would otherwise drop it for a generic line that does
      // not fit, e.g. "Reload and apply your change again" for a reused Idempotency-Key.
      remediation: e.context.detail ?? e.remediation,
    };
  }
  if (e instanceof TenantScopeError) return problemFor('INTERNAL');
  return problemFor('INTERNAL');
}

export function errorResponse(e: unknown, headers?: HeadersInit): Response {
  return problemResponse(problemFromError(e), headers);
}
