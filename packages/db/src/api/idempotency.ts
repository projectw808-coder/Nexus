/**
 * `Idempotency-Key` support for REST v1 writes (spec §11.2).
 *
 * A key is remembered with the hash of the request that used it and the response that request
 * produced. Presenting the same key with the same request replays the stored response verbatim
 * and the handler never runs a second time; presenting it with a *different* request is a
 * client error (409) rather than a silent second side effect.
 */
import { NexusError } from '@nexus/core';
import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';

export type IdempotencyRef = {
  workspaceId: string;
  apiKeyId?: string | null;
  key: string;
  requestHash: string;
};

export type StoredResponse = { status: number; body: unknown };

/** The canonical request fingerprint: method, path and the exact bytes of the body. */
export function requestHashFor(input: { method: string; path: string; body: string }): string {
  return createHash('sha256')
    .update(`${input.method.toUpperCase()}\n${input.path}\n${input.body}`, 'utf8')
    .digest('hex');
}

/**
 * A hit means "replay this, do not re-run the handler". A stored row whose `requestHash`
 * disagrees throws CONFLICT — the caller reused one key for two different requests.
 */
export async function checkIdempotency(
  db: TenantDb,
  ref: IdempotencyRef,
): Promise<StoredResponse | null> {
  const row = await db.apiIdempotencyKey.findFirst({
    where: { workspaceId: ref.workspaceId, key: ref.key },
    select: { requestHash: true, responseStatus: true, responseBody: true },
  });
  if (!row) return null;
  if (row.requestHash !== ref.requestHash) {
    throw new NexusError('CONFLICT', {
      context: {
        reason: `The Idempotency-Key "${ref.key}" was already used for a different request.`,
        detail: 'Use a fresh Idempotency-Key for a request with a different method, path or body.',
      },
      details: { idempotencyKey: ref.key },
    });
  }
  return { status: row.responseStatus, body: row.responseBody };
}

/**
 * Remember the response a key produced. A concurrent duplicate loses the `(workspaceId, key)`
 * unique race; that is harmless (the winner stored the identical response), so it is swallowed.
 */
export async function recordIdempotency(
  db: TenantDb,
  ref: IdempotencyRef,
  status: number,
  body: unknown,
): Promise<void> {
  await db.apiIdempotencyKey.createMany({
    data: [
      {
        workspaceId: ref.workspaceId,
        apiKeyId: ref.apiKeyId ?? null,
        key: ref.key,
        requestHash: ref.requestHash,
        responseStatus: status,
        responseBody: (body ?? null) as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
}
