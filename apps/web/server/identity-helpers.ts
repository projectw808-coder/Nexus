/**
 * Shared shapes for the identity, timeline and merge-suggestion routers: how an identity and
 * a person are summarised for the UI, and how evidence is passed through verbatim.
 */
import type { IdentityLinkModel, IdentityModel, TenantDb } from '@nexus/db';
import { handleHistoryOf, personAttributes } from '@nexus/db';
import { attributesFor, recordLabel } from './objects-helpers';

export type IdentitySummary = {
  id: string;
  platform: IdentityModel['platform'];
  externalId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  email: string | null;
  phone: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  personRecordId: string | null;
  resolutionAttemptedAt: Date | null;
};

export function identitySummary(i: IdentityModel): IdentitySummary {
  return {
    id: i.id,
    platform: i.platform,
    externalId: i.externalId,
    handle: i.handle,
    displayName: i.displayName,
    avatarUrl: i.avatarUrl,
    profileUrl: i.profileUrl,
    email: i.email,
    phone: i.phone,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    personRecordId: i.personRecordId,
    resolutionAttemptedAt: i.resolutionAttemptedAt,
  };
}

export type LinkSummary = {
  id: string;
  method: IdentityLinkModel['method'];
  confidence: number;
  evidence: unknown;
  confirmedAt: Date | null;
  confirmedBy: { name: string | null; email: string } | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export function linkSummary(
  l: IdentityLinkModel & { confirmedBy?: { name: string | null; email: string } | null },
): LinkSummary {
  return {
    id: l.id,
    method: l.method,
    confidence: l.confidence,
    evidence: l.evidence,
    confirmedAt: l.confirmedAt,
    confirmedBy: l.confirmedBy ?? null,
    revokedAt: l.revokedAt,
    createdAt: l.createdAt,
  };
}

export function handleHistory(raw: unknown) {
  return handleHistoryOf(raw);
}

/** `{ id → label }` for person records, in one query. */
export async function personLabels(
  db: TenantDb,
  ids: string[],
): Promise<Map<string, { label: string; mergeState: string; deletedAt: Date | null }>> {
  const out = new Map<string, { label: string; mergeState: string; deletedAt: Date | null }>();
  if (!ids.length) return out;
  const pa = await personAttributes(db);
  const attrs = await attributesFor(db, pa.objectTypeId);
  const rows = await db.record.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, values: true, mergeState: true, deletedAt: true },
  });
  for (const r of rows)
    out.set(r.id, {
      label: recordLabel(attrs, r.values as Record<string, unknown>),
      mergeState: r.mergeState,
      deletedAt: r.deletedAt,
    });
  return out;
}

export type SuggestionSignals = {
  score: number;
  method?: string;
  signals: {
    kind: string;
    tier: number;
    weight: number;
    label: string;
    left: unknown;
    right: unknown;
  }[];
};

export function signalsOf(value: unknown): SuggestionSignals {
  const v = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Partial<SuggestionSignals>;
  return {
    score: typeof v.score === 'number' ? v.score : 0,
    ...(typeof v.method === 'string' ? { method: v.method } : {}),
    signals: Array.isArray(v.signals) ? v.signals : [],
  };
}
