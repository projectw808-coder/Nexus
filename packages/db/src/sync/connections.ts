/**
 * `Connection` lifecycle from the engine's point of view: creation after OAuth, status
 * transitions driven by the failure taxonomy, and the cross-tenant lookups the webhook
 * receiver and the scheduler need (system client, this package only — ADR-006).
 */
import {
  connectionSettingsSchema,
  type ConnectionSettings,
  type ConnectionSettingsInput,
} from '@nexus/connector-sdk';
import type { ConnStatus, Platform } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Actor, SystemDb, TenantDb, TenantRuntime } from '../scoped.ts';

/** The actor a background job impersonates for one connection: system-typed, owner-level, tenant-scoped. */
export function systemActorFor(workspaceId: string, connectionId?: string): Actor {
  return {
    workspaceId,
    userId: null,
    role: 'OWNER',
    grants: [],
    actorType: 'SYSTEM',
    actorRef: connectionId ?? null,
  };
}

export type CreateConnectionInput = {
  workspaceId: string;
  platform: Platform;
  label: string;
  accountExternalId: string;
  accountName: string;
  accountAvatarUrl?: string | null;
  scopesGranted: string[];
  scopesRequired: string[];
  capabilities: string[];
  apiVersion: string;
  tokenRef: string;
  tokenExpiresAt?: Date | null;
  refreshableUntil?: Date | null;
  webhookSecretRef?: string | null;
  ownerUserId: string | null;
  settings?: ConnectionSettingsInput;
};

/** Create or re-attach (same workspace + platform + account) a connection. Re-attaching refreshes the token handle and scopes. */
export async function upsertConnection(
  db: TenantDb,
  input: CreateConnectionInput,
): Promise<{ id: string; created: boolean }> {
  const settings = connectionSettingsSchema.parse(input.settings ?? {});
  const existing = await db.connection.findFirst({
    where: {
      workspaceId: input.workspaceId,
      platform: input.platform,
      accountExternalId: input.accountExternalId,
    },
    select: { id: true, deletedAt: true },
  });
  const data = {
    label: input.label,
    accountName: input.accountName,
    accountAvatarUrl: input.accountAvatarUrl ?? null,
    status: 'CONNECTED' as const,
    scopesGranted: input.scopesGranted,
    scopesRequired: input.scopesRequired,
    capabilities: input.capabilities,
    degradedCapabilities: [] as string[],
    apiVersion: input.apiVersion,
    tokenRef: input.tokenRef,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    refreshableUntil: input.refreshableUntil ?? null,
    webhookSecretRef: input.webhookSecretRef ?? null,
    pausedReason: null,
    healthScore: 100,
    deletedAt: null,
  };
  if (existing) {
    await db.connection.update({
      where: { id: existing.id },
      data: { ...data, ownerUserId: input.ownerUserId },
    });
    return { id: existing.id, created: false };
  }
  const created = await db.connection.create({
    data: {
      ...data,
      workspaceId: input.workspaceId,
      platform: input.platform,
      accountExternalId: input.accountExternalId,
      ownerUserId: input.ownerUserId,
      settings: settings as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export type ConnectionRow = NonNullable<Awaited<ReturnType<typeof getConnection>>>;

export async function getConnection(db: TenantDb, id: string) {
  const row = await db.connection.findFirst({ where: { id, deletedAt: null } });
  if (!row) return null;
  return { ...row, settings: connectionSettingsSchema.parse(row.settings ?? {}) };
}

export async function setConnectionStatus(
  db: TenantDb,
  id: string,
  status: ConnStatus,
  opts: {
    pausedReason?: string | null;
    healthScore?: number;
    degradedCapabilities?: string[];
  } = {},
): Promise<void> {
  await db.connection.update({
    where: { id },
    data: {
      status,
      ...(opts.pausedReason !== undefined ? { pausedReason: opts.pausedReason } : {}),
      ...(opts.healthScore !== undefined ? { healthScore: opts.healthScore } : {}),
      ...(opts.degradedCapabilities !== undefined
        ? { degradedCapabilities: opts.degradedCapabilities }
        : {}),
    },
  });
}

export async function touchConnectionSync(
  db: TenantDb,
  id: string,
  opts: { success: boolean },
): Promise<void> {
  const now = new Date();
  await db.connection.update({
    where: { id },
    data: { lastSyncAt: now, ...(opts.success ? { lastSuccessAt: now } : {}) },
  });
}

export async function updateConnectionSettings(
  db: TenantDb,
  id: string,
  patch: Partial<ConnectionSettings>,
): Promise<ConnectionSettings> {
  const row = await db.connection.findFirstOrThrow({ where: { id }, select: { settings: true } });
  const next = connectionSettingsSchema.parse({ ...(row.settings as object), ...patch });
  await db.connection.update({
    where: { id },
    data: { settings: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

// ─── cross-tenant lookups (system client) ───────────────────────────────────

/** Route an inbound webhook to its connection from whatever the connector could extract. */
export async function findConnectionForWebhook(
  runtime: TenantRuntime,
  hint: { platform: Platform; connectionId?: string; accountExternalId?: string },
): Promise<{
  id: string;
  workspaceId: string;
  webhookSecretRef: string | null;
  status: ConnStatus;
} | null> {
  return runtime.withSystem(async (db: SystemDb) => {
    const where: Prisma.ConnectionWhereInput = hint.connectionId
      ? { id: hint.connectionId, platform: hint.platform, deletedAt: null }
      : hint.accountExternalId
        ? { platform: hint.platform, accountExternalId: hint.accountExternalId, deletedAt: null }
        : { id: '__none__' };
    const row = await db.connection.findFirst({
      where,
      select: { id: true, workspaceId: true, webhookSecretRef: true, status: true },
    });
    return row;
  });
}

/** Every live connection with its enabled resources — the scheduler's input. */
export async function listSchedulableConnections(runtime: TenantRuntime): Promise<
  {
    id: string;
    workspaceId: string;
    platform: Platform;
    status: ConnStatus;
    settings: ConnectionSettings;
  }[]
> {
  return runtime.withSystem(async (db: SystemDb) => {
    const rows = await db.connection.findMany({
      where: { deletedAt: null, status: { in: ['CONNECTED', 'DEGRADED'] } },
      select: { id: true, workspaceId: true, platform: true, status: true, settings: true },
    });
    return rows
      .map((r) => ({ ...r, settings: connectionSettingsSchema.parse(r.settings ?? {}) }))
      .filter((r) => !r.settings.paused);
  });
}

/** Connections whose token is due for refresh or nearing an unrefreshable expiry (§5.4 sweep). */
export async function listConnectionsForTokenSweep(runtime: TenantRuntime, before: Date) {
  return runtime.withSystem(async (db: SystemDb) =>
    db.connection.findMany({
      where: {
        deletedAt: null,
        status: { in: ['CONNECTED', 'DEGRADED'] },
        tokenExpiresAt: { lte: before },
      },
      select: {
        id: true,
        workspaceId: true,
        platform: true,
        tokenRef: true,
        tokenExpiresAt: true,
        refreshableUntil: true,
        ownerUserId: true,
        label: true,
        // For the reconnect-required e-mail (Phase 9): who to notify and where to send them.
        owner: { select: { email: true } },
        workspace: { select: { name: true, slug: true } },
      },
    }),
  );
}
