/**
 * Maps anything thrown by the tRPC caller into the sentence the UI shows (§9.2). TRPCErrors
 * carry a user-facing `message`; when the cause is a NexusError we also surface its
 * remediation. Anything else is a generic sentence — never a stack trace or an internal detail.
 */
import { NexusError } from '@nexus/core';
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';

const GENERIC = 'Something went wrong on our side.';

export type UserFacingError = { message: string; remediation: string | null };

export function describeError(e: unknown): UserFacingError {
  if (e instanceof TRPCError) {
    const cause = e.cause;
    if (NexusError.is(cause)) {
      return { message: cause.userMessage || e.message, remediation: cause.remediation || null };
    }
    return { message: e.message || GENERIC, remediation: null };
  }
  if (NexusError.is(e)) return { message: e.userMessage, remediation: e.remediation || null };
  return { message: GENERIC, remediation: null };
}

export function messageOf(e: unknown): string {
  return describeError(e).message;
}

export function remediationOf(e: unknown): string | null {
  return describeError(e).remediation;
}

export function isCode(e: unknown, ...codes: TRPC_ERROR_CODE_KEY[]): boolean {
  return e instanceof TRPCError && codes.includes(e.code);
}
