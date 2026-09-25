/**
 * Dead-letter queue (§9.2): a job that exhausted its retries lands here with its payload and
 * the classified error, for one-click replay from the console or `pnpm nexus dlq replay`.
 */
import { NexusError } from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';
import { toIntegrationErrorClass } from './errors.ts';

export async function recordDeadLetter(
  db: TenantDb,
  input: {
    workspaceId: string;
    connectionId?: string | null;
    queue: string;
    jobName: string;
    payload: unknown;
    error: unknown;
    attempts: number;
  },
): Promise<{ id: string }> {
  const e = input.error instanceof NexusError ? input.error : null;
  return db.deadLetter.create({
    data: {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId ?? null,
      queue: input.queue,
      jobName: input.jobName,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      errorClass: toIntegrationErrorClass(e?.code),
      errorCode: e?.code ?? 'INTERNAL',
      errorMessage: e
        ? e.message
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
      attempts: input.attempts,
    },
    select: { id: true },
  });
}

export async function listDeadLetters(
  db: TenantDb,
  filter: { connectionId?: string; includeReplayed?: boolean; limit?: number } = {},
) {
  return db.deadLetter.findMany({
    where: {
      ...(filter.connectionId ? { connectionId: filter.connectionId } : {}),
      ...(filter.includeReplayed ? {} : { replayedAt: null }),
    },
    orderBy: { failedAt: 'desc' },
    take: filter.limit ?? 100,
  });
}

export async function markReplayed(
  db: TenantDb,
  id: string,
  replayJobId: string | null,
): Promise<void> {
  await db.deadLetter.update({ where: { id }, data: { replayedAt: new Date(), replayJobId } });
}
