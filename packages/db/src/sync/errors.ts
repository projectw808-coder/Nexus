/**
 * `IntegrationError` rows behind the §9.2 taxonomy: the machine class and code plus the human
 * remediation string the UI renders, linked to the run / object / action that failed.
 */
import { NexusError, type FailureClass } from '@nexus/core';
import type { IntegrationErrorClass, Platform } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';

const CLASSES: ReadonlySet<string> = new Set<IntegrationErrorClass>([
  'AUTH_EXPIRED',
  'SCOPE_MISSING',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'PLATFORM_DOWN',
  'SCHEMA_DRIFT',
  'POLICY_BLOCKED',
  'DUPLICATE',
]);

export function toIntegrationErrorClass(code: FailureClass | undefined): IntegrationErrorClass {
  return code && CLASSES.has(code) ? (code as IntegrationErrorClass) : 'UNKNOWN';
}

export async function recordIntegrationError(
  db: TenantDb,
  input: {
    workspaceId: string;
    connectionId?: string | null;
    syncRunId?: string | null;
    externalObjectId?: string | null;
    outboundActionId?: string | null;
    platform?: Platform | null;
    error: unknown;
  },
): Promise<{ id: string }> {
  const e = input.error instanceof NexusError ? input.error : null;
  const message = e
    ? e.userMessage
    : input.error instanceof Error
      ? input.error.message
      : String(input.error);
  return db.integrationError.create({
    data: {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId ?? null,
      syncRunId: input.syncRunId ?? null,
      externalObjectId: input.externalObjectId ?? null,
      outboundActionId: input.outboundActionId ?? null,
      platform: input.platform ?? null,
      errorClass: toIntegrationErrorClass(e?.code),
      code: e?.code ?? 'INTERNAL',
      message,
      remediation: e?.remediation ?? null,
      httpStatus: e ? (typeof e.details.status === 'number' ? e.details.status : null) : null,
      details: (e
        ? { ...e.details, technicalMessage: e.message }
        : { technicalMessage: message }) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
}
