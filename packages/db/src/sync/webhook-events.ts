/**
 * `WebhookEvent` persistence for the receiver (§11.3): every inbound payload is logged —
 * verified or not, routable or not — before anything else happens. Processing is tracked on
 * the row so the reconciliation poll can measure `webhook_lag_seconds` and replays are safe.
 */
import type { Platform } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { SystemDb, TenantDb, TenantRuntime } from '../scoped.ts';

export type WebhookEventInput = {
  workspaceId: string | null;
  connectionId: string | null;
  platform: Platform;
  headers: Record<string, string>;
  body: unknown;
  verified: boolean;
  /** Only meaningful when `verified` is false — the taxonomy's remediation string (§9.2). */
  remediation?: string | null;
  receivedAt?: Date;
};

const SAFE_HEADERS = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'x-hub-signature-256',
  'x-mock-signature',
  'x-mock-delivery',
  'x-delivery-id',
]);

function safeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (SAFE_HEADERS.has(key)) out[key] = key.includes('signature') ? `${v.slice(0, 12)}…` : v;
  }
  return out;
}

function toCreateData(input: WebhookEventInput) {
  return {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: input.platform,
    headers: safeHeaders(input.headers),
    body: (input.body ?? null) as Prisma.InputJsonValue,
    verified: input.verified,
    remediation: input.remediation ?? null,
    receivedAt: input.receivedAt ?? new Date(),
  };
}

/** Unverified or unroutable payloads have no tenant yet, so the receiver logs them on the system client. */
export async function recordSystemWebhookEvent(
  db: SystemDb,
  input: WebhookEventInput,
): Promise<{ id: string }> {
  return db.webhookEvent.create({ data: toCreateData(input), select: { id: true } });
}

/** Same, from outside the db package (the engine cannot open a system transaction itself — ADR-006). */
export async function recordUnroutedWebhookEvent(
  runtime: TenantRuntime,
  input: WebhookEventInput,
): Promise<{ id: string }> {
  return runtime.withSystem((db) => recordSystemWebhookEvent(db, input));
}

export async function recordWebhookEvent(
  db: TenantDb,
  input: WebhookEventInput,
): Promise<{ id: string }> {
  return db.webhookEvent.create({ data: toCreateData(input), select: { id: true } });
}

export async function markWebhookProcessed(
  db: TenantDb,
  id: string,
  outcome: { error?: string | null },
): Promise<void> {
  await db.webhookEvent.update({
    where: { id },
    data: {
      attempts: { increment: 1 },
      processedAt: outcome.error ? null : new Date(),
      lastError: outcome.error ?? null,
    },
  });
}

export async function unprocessedWebhookEvents(
  db: TenantDb,
  connectionId: string,
  limit = 200,
): Promise<{ id: string }[]> {
  return db.webhookEvent.findMany({
    where: { connectionId, verified: true, processedAt: null },
    orderBy: { receivedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
}

/** The delivery log (§12.2.C): every inbound payload for one connection, newest first. */
export async function listWebhookEvents(
  db: TenantDb,
  input: { connectionId: string; verified?: boolean; limit?: number },
) {
  return db.webhookEvent.findMany({
    where: {
      connectionId: input.connectionId,
      ...(input.verified !== undefined ? { verified: input.verified } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: input.limit ?? 50,
  });
}

export async function getWebhookEvent(db: TenantDb, id: string) {
  return db.webhookEvent.findFirst({ where: { id } });
}

/** Workspace-wide delivery health (the health console, §12.2.C): counts and lag over a window. */
export async function webhookHealthSummary(
  db: TenantDb,
  input: { since: Date },
): Promise<{
  total: number;
  rejected: number;
  unprocessed: number;
  avgLagMs: number | null;
  maxLagMs: number | null;
}> {
  const rows = await db.webhookEvent.findMany({
    where: { receivedAt: { gte: input.since } },
    select: { verified: true, receivedAt: true, processedAt: true },
  });
  const lags = rows
    .filter((r) => r.processedAt)
    .map((r) => r.processedAt!.getTime() - r.receivedAt.getTime());
  return {
    total: rows.length,
    rejected: rows.filter((r) => !r.verified).length,
    unprocessed: rows.filter((r) => r.verified && !r.processedAt).length,
    avgLagMs: lags.length ? Math.round(lags.reduce((s, n) => s + n, 0) / lags.length) : null,
    maxLagMs: lags.length ? Math.max(...lags) : null,
  };
}
