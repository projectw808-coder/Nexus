/**
 * Consent tracking (§5.5, ADR-022 decision 3).
 *
 * One `ConsentRecord` per `(identity, channel)`; `channel` is a `Platform` name for a platform
 * DM/comment channel, or `"email"`/`"sms"` for the rest. `UNKNOWN` is the state of a channel
 * nobody has asked about — it is NOT an error and never throws.
 *
 * ADR-022 decision 3 fixes the gate's scope: `WITHDRAWN` blocks an *unprompted* outbound send
 * (a `@nexus/automation` `send_reply`/`send_email` step); `UNKNOWN` and `GRANTED` both proceed.
 * A human replying to a specific inbound message is never gated — that is a transactional
 * response, not marketing, and gating it would make the unified inbox unusable.
 */
import { writeAudit, type AuditEntry } from '../audit.ts';
import type { ConsentStatus, Platform } from '../generated/prisma/enums.ts';
import type { Actor, TenantDb } from '../scoped.ts';

/** Non-platform channels a consent row can be keyed on, alongside every `Platform` name. */
export const NON_PLATFORM_CONSENT_CHANNELS = ['email', 'sms'] as const;
export type NonPlatformConsentChannel = (typeof NON_PLATFORM_CONSENT_CHANNELS)[number];
export type ConsentChannel = Platform | NonPlatformConsentChannel;

export type ConsentRow = {
  id: string;
  identityId: string;
  channel: string;
  status: ConsentStatus;
  source: string | null;
  capturedAt: Date;
};

/**
 * Current consent for one identity on one channel. Returns `'UNKNOWN'` when no row exists —
 * "nobody has asked" is a state, not a failure.
 */
export async function getConsent(
  db: TenantDb,
  identityId: string,
  channel: string,
): Promise<ConsentStatus> {
  const row = await db.consentRecord.findFirst({
    where: { identityId, channel },
    select: { status: true },
  });
  return row?.status ?? 'UNKNOWN';
}

export type RecordConsentInput = {
  identityId: string;
  /** A `ConsentChannel` in practice; typed as `string` because the column is. */
  channel: string;
  status: ConsentStatus;
  /** How it was captured or withdrawn, e.g. "lead_form", "unsubscribe_link", "manual". */
  source?: string | null;
  /** When the subject actually granted/withdrew, if that differs from now. */
  capturedAt?: Date;
};

/**
 * Where the audit row goes. A tRPC mutation passes `ctx.audit` (which is also what satisfies
 * `tenantProcedure`'s "every mutation writes an audit row" guard); a job passes nothing and gets
 * a direct `writeAudit` in the same transaction.
 */
export type ConsentAuditSink = (entry: AuditEntry) => Promise<void>;

/**
 * Set (or withdraw) consent for one identity on one channel. Upserts on
 * `(workspaceId, identityId, channel)` and writes one audit row, so a withdrawal is always
 * provable after the fact.
 */
export async function recordConsent(
  db: TenantDb,
  actor: Actor,
  input: RecordConsentInput,
  audit?: ConsentAuditSink,
): Promise<ConsentRow> {
  const channel = String(input.channel);
  const capturedAt = input.capturedAt ?? new Date();
  // Find-then-write rather than `upsert` on the composite unique: the same shape every other
  // store in this package uses (see sync/cursors.ts), and the one the scoped client handles
  // without a compound extended-where.
  const existing = await db.consentRecord.findFirst({
    where: { identityId: input.identityId, channel },
    select: { id: true, status: true },
  });
  const row = existing
    ? await db.consentRecord.update({
        where: { id: existing.id },
        data: { status: input.status, source: input.source ?? null, capturedAt },
      })
    : await db.consentRecord.create({
        data: {
          workspaceId: actor.workspaceId,
          identityId: input.identityId,
          channel,
          status: input.status,
          source: input.source ?? null,
          capturedAt,
        },
      });
  const entry: AuditEntry = {
    action: input.status === 'WITHDRAWN' ? 'consent.withdrawn' : 'consent.recorded',
    targetType: 'ConsentRecord',
    targetId: row.id,
    diff: {
      identityId: input.identityId,
      channel,
      from: existing?.status ?? 'UNKNOWN',
      to: input.status,
      source: input.source ?? null,
    },
  };
  await (audit ? audit(entry) : writeAudit(db, actor, entry));
  return row;
}

/** Every consent row for one identity, newest capture first. */
export async function listConsentForIdentity(
  db: TenantDb,
  identityId: string,
): Promise<ConsentRow[]> {
  return db.consentRecord.findMany({
    where: { identityId },
    orderBy: [{ channel: 'asc' }],
    select: {
      id: true,
      identityId: true,
      channel: true,
      status: true,
      source: true,
      capturedAt: true,
    },
  });
}

export type ConsentListRow = ConsentRow & {
  identity: {
    id: string;
    platform: Platform;
    handle: string | null;
    displayName: string | null;
    email: string | null;
  };
};

/**
 * Workspace-wide consent view for the admin screen. Defaults to the rows that matter — the
 * withdrawals — because `UNKNOWN` is the state of nearly every identity and listing it is noise.
 */
export async function listConsent(
  db: TenantDb,
  input: { channel?: string; status?: ConsentStatus; limit?: number } = {},
): Promise<ConsentListRow[]> {
  return db.consentRecord.findMany({
    where: {
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ capturedAt: 'desc' }],
    take: Math.min(input.limit ?? 100, 500),
    select: {
      id: true,
      identityId: true,
      channel: true,
      status: true,
      source: true,
      capturedAt: true,
      identity: {
        select: { id: true, platform: true, handle: true, displayName: true, email: true },
      },
    },
  });
}

/** How many rows sit in each status, for the admin screen's header. */
export async function consentCounts(db: TenantDb): Promise<Record<ConsentStatus, number>> {
  const rows = await db.consentRecord.groupBy({ by: ['status'], _count: { _all: true } });
  const out: Record<ConsentStatus, number> = { UNKNOWN: 0, GRANTED: 0, WITHDRAWN: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

// ── The outbound gate (ADR-022 decision 3) ──────────────────────────────────

/** What an unprompted outbound send is aimed at. */
export type OutboundConsentTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'identity'; identityId: string; channel: string }
  | { kind: 'email'; email: string };

export type ConsentDecision = {
  allowed: boolean;
  status: ConsentStatus;
  channel: string;
  /** The identity the decision was made about; null when no identity could be matched. */
  identityId: string | null;
  /** Present only when `allowed` is false — the sentence a blocked workflow step reports. */
  reason?: string;
};

/**
 * The consent gate for an *unprompted* outbound send (`@nexus/automation`'s
 * `send_reply`/`send_email`). Only `WITHDRAWN` blocks; `UNKNOWN` and `GRANTED` both proceed
 * (ADR-022 decision 3 — this product has no allowlist-only channel and no bulk-marketing
 * feature, so treating the overwhelmingly common default as a block would only break workflows).
 *
 * For an email target with no matching `Identity`, there is nothing to have withdrawn and the
 * send proceeds — an address typed into a workflow step is not necessarily a known person.
 */
export async function consentAllowsSend(
  db: TenantDb,
  target: OutboundConsentTarget,
): Promise<ConsentDecision> {
  const { identityIds, channel } = await resolveTarget(db, target);
  if (identityIds.length === 0) {
    return { allowed: true, status: 'UNKNOWN', channel, identityId: null };
  }
  const rows = await db.consentRecord.findMany({
    where: { identityId: { in: identityIds }, channel },
    select: { identityId: true, status: true },
  });
  // One address can belong to several channel identities (the same person on Instagram and X).
  // A withdrawal on any of them is a withdrawal for that address: the strictest answer wins.
  const withdrawn = rows.find((r) => r.status === 'WITHDRAWN');
  if (withdrawn) {
    return {
      allowed: false,
      status: 'WITHDRAWN',
      channel,
      identityId: withdrawn.identityId,
      reason: `Consent for ${channel} was withdrawn for this person — an automated send is blocked (§5.5). A human can still reply to an inbound message.`,
    };
  }
  const granted = rows.find((r) => r.status === 'GRANTED');
  return {
    allowed: true,
    status: granted ? 'GRANTED' : 'UNKNOWN',
    channel,
    identityId: granted?.identityId ?? identityIds[0] ?? null,
  };
}

async function resolveTarget(
  db: TenantDb,
  target: OutboundConsentTarget,
): Promise<{ identityIds: string[]; channel: string }> {
  if (target.kind === 'identity') {
    return { identityIds: [target.identityId], channel: String(target.channel) };
  }
  if (target.kind === 'email') {
    const rows = await db.identity.findMany({
      where: { email: target.email, deletedAt: null },
      select: { id: true },
    });
    return { identityIds: rows.map((r) => r.id), channel: 'email' };
  }
  const conv = await db.conversation.findFirst({
    where: { id: target.conversationId },
    select: { identityId: true, platform: true },
  });
  return {
    identityIds: conv?.identityId ? [conv.identityId] : [],
    channel: conv?.platform ?? 'email',
  };
}
