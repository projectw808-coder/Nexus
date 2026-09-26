/**
 * `OutboundWebhookDelivery`: the delivery log, one signed POST attempt, and replay (§11.2).
 *
 * The attempt/retry bookkeeping lives on the row rather than inside BullMQ's own retry counter,
 * for the same reason `OutboundAction` tracks `attempts` itself (`packages/sync/src/outbound.ts`):
 * the delivery log UI has to show *why* something has not arrived and *when* the next try is, and
 * `@@index([workspaceId, status, nextAttemptAt])` exists in the schema for exactly that. The
 * timing itself is the codebase-wide §9.2 policy — `nextDelayMs` / `shouldRetry` / `MAX_ATTEMPTS`
 * from the connector SDK — so every retry path in Nexus still agrees on one backoff formula.
 *
 * A failed attempt therefore does NOT throw: it records the outcome and tells the caller to
 * re-enqueue after `delayMs`. Only a genuinely unexpected fault (a missing row, an unreadable
 * secret) throws, where a queue-level retry is the right response.
 */
import { MAX_ATTEMPTS, nextDelayMs, shouldRetry, type FetchLike } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import type { OutboundDeliveryStatus } from '../generated/prisma/enums.ts';
import type { Actor, TenantDb, TenantRuntime } from '../scoped.ts';
import { systemActorFor } from '../sync/connections.ts';
import type { Vault } from '../vault.ts';
import type { PendingOutboundDelivery } from './events.ts';
import {
  ATTEMPT_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  SUBSCRIPTION_HEADER,
  signatureHeaderValue,
} from './signing.ts';

/** A misbehaving (or hostile) endpoint must not be able to grow the database. */
export const RESPONSE_BODY_LIMIT = 2_048;
/** A slow customer endpoint must not hold a queue slot. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** The JSON body a customer receives. `data` is the event payload; `id` is the delivery id. */
export type OutboundWebhookBody = {
  id: string;
  event: string;
  createdAt: string;
  workspaceId: string;
  data: unknown;
};

export type DeliveryDeps = {
  runtime: TenantRuntime;
  vault: Vault;
  /** Injected in tests; defaults to global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  retry?: { baseMs?: number; capMs?: number; maxAttempts?: number };
};

export type DeliveryOutcome = {
  deliveryId: string;
  status: OutboundDeliveryStatus | 'SKIPPED';
  attempts: number;
  responseStatus: number | null;
  /** Present when the delivery will be retried; the caller re-enqueues with this delay. */
  retry: { delayMs: number; nextAttemptAt: Date } | null;
  error: string | null;
};

const truncate = (text: string): string =>
  text.length > RESPONSE_BODY_LIMIT ? `${text.slice(0, RESPONSE_BODY_LIMIT)}…` : text;

/** Map an HTTP status onto the §9.2 taxonomy so `shouldRetry` decides, not an ad-hoc rule. */
function errorForStatus(status: number, body: string, retryAfter: string | null): NexusError {
  const details = { status, body: truncate(body) };
  if (status === 429) {
    const seconds = Number(retryAfter);
    return new NexusError('RATE_LIMITED', {
      message: `endpoint returned 429`,
      details,
      context: Number.isFinite(seconds) ? { resumesAt: new Date(Date.now() + seconds * 1000) } : {},
    });
  }
  if (status === 408 || status >= 500)
    return new NexusError('PLATFORM_DOWN', {
      message: `endpoint returned ${status}`,
      details,
    });
  return new NexusError('VALIDATION', {
    message: `endpoint returned ${status}`,
    details,
    context: { reason: `The endpoint rejected the delivery with HTTP ${status}.` },
  });
}

/**
 * Attempt one delivery. Idempotent with respect to state: a delivery already `DELIVERED`, or one
 * whose subscription has been disabled or deleted, is not sent.
 */
export async function runOutboundWebhookDelivery(
  deps: DeliveryDeps,
  job: { workspaceId: string; deliveryId: string },
): Promise<DeliveryOutcome> {
  const actor = systemActorFor(job.workspaceId);
  const now = () => deps.now?.() ?? new Date();
  const maxAttempts = deps.retry?.maxAttempts ?? MAX_ATTEMPTS;

  const loaded = await deps.runtime.withTenant(actor, async (db) => {
    const row = await db.outboundWebhookDelivery.findFirst({
      where: { id: job.deliveryId },
      select: {
        id: true,
        subscriptionId: true,
        eventType: true,
        payload: true,
        status: true,
        attempts: true,
        createdAt: true,
        subscription: {
          select: { id: true, url: true, secretRef: true, enabled: true, deletedAt: true },
        },
      },
    });
    if (!row) return null;
    if (row.status === 'DELIVERED') return { row, secret: null, dead: null } as const;
    const sub = row.subscription;
    if (!sub.enabled || sub.deletedAt)
      return {
        row,
        secret: null,
        dead: sub.deletedAt ? 'subscription was deleted' : 'subscription is disabled',
      } as const;
    const secret = (await deps.vault.get(db, sub.secretRef)).secret;
    await db.outboundWebhookDelivery.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 }, lastAttemptAt: now(), nextAttemptAt: null },
    });
    return { row, secret, dead: null } as const;
  });

  if (!loaded)
    // Almost always a race with the producer's transaction: the delivery row is not visible yet.
    // A queue-level retry is exactly right, so throw a retryable error rather than losing it.
    throw new NexusError('INTERNAL', {
      message: `outbound webhook delivery ${job.deliveryId} not found (yet)`,
    });

  const { row, secret, dead } = loaded;
  if (row.status === 'DELIVERED')
    return {
      deliveryId: row.id,
      status: 'SKIPPED',
      attempts: row.attempts,
      responseStatus: null,
      retry: null,
      error: null,
    };
  if (dead) {
    await deps.runtime.withTenant(actor, (db) =>
      db.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: { status: 'DEAD_LETTERED', responseBody: dead, lastAttemptAt: now() },
      }),
    );
    return {
      deliveryId: row.id,
      status: 'DEAD_LETTERED',
      attempts: row.attempts,
      responseStatus: null,
      retry: null,
      error: dead,
    };
  }

  const attempt = row.attempts + 1;
  const body: OutboundWebhookBody = {
    id: row.id,
    event: row.eventType,
    createdAt: row.createdAt.toISOString(),
    workspaceId: job.workspaceId,
    data: row.payload,
  };
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(now().getTime() / 1000);
  const doFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));

  let responseStatus: number | null = null;
  let responseBody = '';
  let failure: NexusError | null = null;
  try {
    const response = await doFetch(row.subscription.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Nexus-Webhooks/1',
        [SIGNATURE_HEADER.toLowerCase()]: signatureHeaderValue(secret!, timestamp, rawBody),
        [EVENT_HEADER.toLowerCase()]: row.eventType,
        [DELIVERY_HEADER.toLowerCase()]: row.id,
        [ATTEMPT_HEADER.toLowerCase()]: String(attempt),
        [SUBSCRIPTION_HEADER.toLowerCase()]: row.subscriptionId,
      },
      body: rawBody,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    responseStatus = response.status;
    responseBody = await response.text().catch(() => '');
    if (response.status < 200 || response.status >= 300)
      failure = errorForStatus(response.status, responseBody, response.headers.get('retry-after'));
  } catch (e) {
    // A transport fault or the timeout above: unknown errors are retryable by policy.
    failure = NexusError.from(e, 'PLATFORM_DOWN');
    responseBody = e instanceof Error ? e.message : String(e);
  }

  if (!failure) {
    await deps.runtime.withTenant(actor, (db) =>
      db.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: now(),
          responseStatus,
          responseBody: truncate(responseBody),
          nextAttemptAt: null,
        },
      }),
    );
    return {
      deliveryId: row.id,
      status: 'DELIVERED',
      attempts: attempt,
      responseStatus,
      retry: null,
      error: null,
    };
  }

  const willRetry = shouldRetry(failure, attempt, maxAttempts);
  const delayMs = willRetry
    ? nextDelayMs(attempt - 1, failure, {
        baseMs: deps.retry?.baseMs ?? 1_000,
        capMs: deps.retry?.capMs ?? 60_000,
        now: () => now().getTime(),
      })
    : 0;
  const nextAttemptAt = willRetry ? new Date(now().getTime() + delayMs) : null;
  const message = failure.message;
  await deps.runtime.withTenant(actor, (db) =>
    db.outboundWebhookDelivery.update({
      where: { id: row.id },
      data: {
        status: willRetry ? 'FAILED' : 'DEAD_LETTERED',
        responseStatus,
        responseBody: truncate(responseBody || message),
        nextAttemptAt,
      },
    }),
  );
  return {
    deliveryId: row.id,
    status: willRetry ? 'FAILED' : 'DEAD_LETTERED',
    attempts: attempt,
    responseStatus,
    retry: willRetry ? { delayMs, nextAttemptAt: nextAttemptAt! } : null,
    error: message,
  };
}

// ── The delivery log ──────────────────────────────────────────────────────────

export type DeliveryRow = {
  id: string;
  subscriptionId: string;
  eventType: string;
  status: OutboundDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  responseBody: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
};

const deliverySelect = {
  id: true,
  subscriptionId: true,
  eventType: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  lastAttemptAt: true,
  responseStatus: true,
  responseBody: true,
  deliveredAt: true,
  createdAt: true,
} as const;

/** The delivery log for one subscription (or the whole workspace), newest first. */
export async function listDeliveries(
  db: TenantDb,
  input: { subscriptionId?: string; status?: OutboundDeliveryStatus; limit?: number },
): Promise<DeliveryRow[]> {
  return db.outboundWebhookDelivery.findMany({
    where: {
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 50,
    select: deliverySelect,
  });
}

export async function getDelivery(
  db: TenantDb,
  id: string,
): Promise<(DeliveryRow & { payload: unknown }) | null> {
  return db.outboundWebhookDelivery.findFirst({
    where: { id },
    select: { ...deliverySelect, payload: true },
  });
}

/** Per-subscription counters for the UI's "3 failing" summary. */
export async function deliveryCounts(
  db: TenantDb,
  subscriptionId: string,
): Promise<Record<OutboundDeliveryStatus, number>> {
  const grouped = await db.outboundWebhookDelivery.groupBy({
    by: ['status'],
    where: { subscriptionId },
    _count: { _all: true },
  });
  const out: Record<OutboundDeliveryStatus, number> = {
    PENDING: 0,
    DELIVERED: 0,
    FAILED: 0,
    DEAD_LETTERED: 0,
  };
  for (const g of grouped as { status: OutboundDeliveryStatus; _count: { _all: number } }[])
    out[g.status] = g._count._all;
  return out;
}

/**
 * Replay: reset the existing row to `PENDING` and hand it back for re-enqueue — the same
 * in-place reset the *inbound* webhook replay uses (Phase 9), so "replay" means one thing in this
 * product. `attempts` is kept (the log should not lie about how many POSTs were made), so a
 * replayed delivery that keeps failing dead-letters again immediately; the counter is reset only
 * when it has already been exhausted, which is what makes a replay useful at all.
 */
export async function replayDelivery(
  db: TenantDb,
  actor: Actor,
  deliveryId: string,
): Promise<PendingOutboundDelivery> {
  const row = await db.outboundWebhookDelivery.findFirst({
    where: { id: deliveryId },
    select: { id: true, subscriptionId: true, eventType: true, status: true, attempts: true },
  });
  if (!row) throw new NexusError('NOT_FOUND', { message: 'Webhook delivery not found.' });
  if (row.status === 'PENDING')
    throw new NexusError('VALIDATION', {
      context: { reason: 'That delivery has not been attempted yet — it is still queued.' },
    });
  const subscription = await db.outboundWebhookSubscription.findFirst({
    where: { id: row.subscriptionId, deletedAt: null },
    select: { id: true, enabled: true },
  });
  if (!subscription)
    throw new NexusError('VALIDATION', {
      context: { reason: 'The subscription this delivery belongs to was deleted.' },
    });
  if (!subscription.enabled)
    throw new NexusError('VALIDATION', {
      context: { reason: 'Enable the subscription before replaying its deliveries.' },
    });
  await db.outboundWebhookDelivery.update({
    where: { id: row.id },
    data: {
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      responseStatus: null,
      responseBody: null,
      deliveredAt: null,
    },
  });
  return {
    deliveryId: row.id,
    workspaceId: actor.workspaceId,
    subscriptionId: row.subscriptionId,
    eventType: row.eventType,
    attempts: 0,
  };
}

/**
 * Deliveries whose retry is due but which no longer have a queue job (a worker died between the
 * row update and the re-enqueue). The worker's five-minute sweep calls this; it is the safety net
 * that makes the on-row `nextAttemptAt` bookkeeping self-healing.
 *
 * Cross-tenant by nature, so it takes the runtime and opens the system transaction itself — the
 * engine is not allowed to (ADR-006), the same reason `recordUnroutedWebhookEvent` exists.
 */
export async function sweepDueOutboundDeliveries(
  runtime: TenantRuntime,
  input: { now?: Date; limit?: number } = {},
): Promise<PendingOutboundDelivery[]> {
  const rows = await runtime.withSystem((db) =>
    db.outboundWebhookDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        nextAttemptAt: { lte: input.now ?? new Date() },
        subscription: { enabled: true, deletedAt: null },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: input.limit ?? 100,
      select: {
        id: true,
        workspaceId: true,
        subscriptionId: true,
        eventType: true,
        attempts: true,
      },
    }),
  );
  return rows.map((r) => ({
    deliveryId: r.id,
    workspaceId: r.workspaceId,
    subscriptionId: r.subscriptionId,
    eventType: r.eventType,
    attempts: r.attempts,
  }));
}
