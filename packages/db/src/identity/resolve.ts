/**
 * The resolver (spec §10, ADR-017): scores an identity against candidate people, links it
 * automatically when the policy allows, files a `MergeSuggestion` when it does not, and
 * creates a Person from an identity that carries a deterministic anchor (e-mail or phone) but
 * matches nobody. Linking backfills `recordId` on the identity's timeline events and
 * `personRecordId` on its conversations in one batched update each (ADR-003).
 */
import { scorePair, type LinkMethodName, type PairScore, type Signal } from '@nexus/core';
import type { LinkMethod, SuggestionStatus } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { createRecord } from '../objects/records.ts';
import { loadAttributes } from '../objects/attributes.ts';
import type { Actor, TenantDb } from '../scoped.ts';
import { candidatePersonsForIdentity, candidatePersonsForPerson } from './candidates.ts';
import { isNeverMerge, mergeRecords } from './merge.ts';
import {
  identityLabel as coreIdentityLabel,
  identitySubject,
  personAttributes,
  personSubject,
} from './subjects.ts';
import { emitTimelineEvent } from './timeline.ts';

export type LinkEvidence = {
  score: number;
  signals: Signal[];
  /** Free text for MANUAL links. */
  note?: string;
};

export type LinkResult = {
  linkId: string;
  identityId: string;
  personRecordId: string;
  backfilled: { timelineEvents: number; conversations: number };
};

/** Attach an identity to a person and backfill its history onto the record. */
export async function linkIdentity(
  db: TenantDb,
  actor: Actor,
  input: {
    identityId: string;
    personRecordId: string;
    method: LinkMethod;
    confidence: number;
    evidence: LinkEvidence;
    confirmed?: boolean;
  },
): Promise<LinkResult> {
  const identity = await db.identity.findFirst({
    where: { id: input.identityId, deletedAt: null },
  });
  if (!identity) throw new Error('identity not found');
  const pa = await personAttributes(db);
  const person = await db.record.findFirst({
    where: {
      id: input.personRecordId,
      objectTypeId: pa.objectTypeId,
      deletedAt: null,
      mergeState: 'ACTIVE',
    },
    select: { id: true },
  });
  if (!person) throw new Error('person not found');
  if (identity.personRecordId && identity.personRecordId !== person.id)
    await unlinkIdentity(db, actor, { identityId: identity.id, reason: 'relinked' });

  const link = await db.identityLink.create({
    data: {
      workspaceId: actor.workspaceId,
      identityId: identity.id,
      personRecordId: person.id,
      method: input.method,
      confidence: input.confidence,
      evidence: input.evidence as unknown as Prisma.InputJsonValue,
      ...(input.confirmed ? { confirmedById: actor.userId, confirmedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  await db.identity.update({
    where: { id: identity.id },
    data: { personRecordId: person.id, resolutionAttemptedAt: new Date() },
  });
  const [events, conversations] = await Promise.all([
    db.timelineEvent.updateMany({
      where: { identityId: identity.id, recordId: null },
      data: { recordId: person.id },
    }),
    db.conversation.updateMany({
      where: { identityId: identity.id, personRecordId: null },
      data: { personRecordId: person.id },
    }),
  ]);
  // Pending suggestions for this identity are settled by the link.
  await db.mergeSuggestion.updateMany({
    where: { identityId: identity.id, status: 'PENDING' },
    data: { status: 'EXPIRED', decidedById: actor.userId, decidedAt: new Date() },
  });
  await emitTimelineEvent(db, {
    workspaceId: actor.workspaceId,
    dedupeKey: `link:${link.id}`,
    type: 'SYSTEM',
    occurredAt: new Date(),
    recordId: person.id,
    identityId: identity.id,
    platform: identity.platform,
    actorUserId: actor.userId,
    summary: `Linked ${platformName(identity.platform)} ${coreIdentityLabel(identity)} (${methodLabel(input.method)}, ${Math.round(input.confidence * 100)}%)`,
    payload: {
      kind: 'identity_linked',
      linkId: link.id,
      method: input.method,
      confidence: input.confidence,
    },
  });
  return {
    linkId: link.id,
    identityId: identity.id,
    personRecordId: person.id,
    backfilled: { timelineEvents: events.count, conversations: conversations.count },
  };
}

/** Detach an identity from its person: the link is revoked, its history goes back to the identity. */
export async function unlinkIdentity(
  db: TenantDb,
  actor: Actor,
  input: { identityId: string; reason?: string | null },
): Promise<{ personRecordId: string | null }> {
  const identity = await db.identity.findFirst({
    where: { id: input.identityId, deletedAt: null },
  });
  if (!identity) throw new Error('identity not found');
  const person = identity.personRecordId;
  if (!person) return { personRecordId: null };
  await db.identityLink.updateMany({
    where: { identityId: identity.id, personRecordId: person, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await db.identity.update({ where: { id: identity.id }, data: { personRecordId: null } });
  await db.timelineEvent.updateMany({
    where: { identityId: identity.id, recordId: person },
    data: { recordId: null },
  });
  await db.conversation.updateMany({
    where: { identityId: identity.id, personRecordId: person },
    data: { personRecordId: null },
  });
  await emitTimelineEvent(db, {
    workspaceId: actor.workspaceId,
    dedupeKey: `unlink:${identity.id}:${Date.now()}`,
    type: 'SYSTEM',
    occurredAt: new Date(),
    recordId: person,
    platform: identity.platform,
    actorUserId: actor.userId,
    summary: `Unlinked ${platformName(identity.platform)} ${coreIdentityLabel(identity)}${input.reason ? ` — ${input.reason}` : ''}`,
    payload: { kind: 'identity_unlinked', identityId: identity.id },
  });
  return { personRecordId: person };
}

/** Create a Person from what the identity knows, then link with the anchor that seeded it. */
export async function createPersonFromIdentity(
  db: TenantDb,
  actor: Actor,
  input: { identityId: string; method?: LinkMethod; evidence?: LinkEvidence },
): Promise<LinkResult & { created: true }> {
  const identity = await db.identity.findFirst({
    where: { id: input.identityId, deletedAt: null },
  });
  if (!identity) throw new Error('identity not found');
  const pa = await personAttributes(db);
  const attrs = await loadAttributes(db, pa.objectTypeId);
  const values: Record<string, unknown> = {};
  const set = (id: string | null, v: string | null) => {
    if (id && v) values[id] = v;
  };
  set(
    pa.ids.name,
    identity.displayName ?? (identity.handle ? `@${identity.handle}` : null) ?? identity.externalId,
  );
  set(pa.ids.email, identity.email);
  set(pa.ids.phone, identity.phone);
  set(pa.ids.avatarUrl, identity.avatarUrl);
  const record = await createRecord(
    db,
    { ...actor, role: 'OWNER' },
    {
      objectTypeId: pa.objectTypeId,
      attributes: attrs,
      input: values,
    },
  );
  const method: LinkMethod =
    input.method ?? (identity.email ? 'EXACT_EMAIL' : identity.phone ? 'PHONE' : 'MANUAL');
  const link = await linkIdentity(db, actor, {
    identityId: identity.id,
    personRecordId: record.id,
    method,
    confidence: 1,
    evidence: input.evidence ?? {
      score: 1,
      signals: [],
      note: `Person created from this ${platformName(identity.platform)} identity`,
    },
    confirmed: actor.userId !== null,
  });
  return { ...link, created: true };
}

export type ResolveOutcome =
  | { action: 'already_linked'; personRecordId: string }
  | { action: 'linked'; personRecordId: string; score: PairScore; linkId: string }
  | { action: 'created'; personRecordId: string; linkId: string }
  | { action: 'suggested'; personRecordId: string; score: PairScore; suggestionId: string }
  | { action: 'unresolved'; best: PairScore | null };

/** Score one identity against its candidates and act on the policy. */
export async function resolveIdentity(
  db: TenantDb,
  actor: Actor,
  input: { identityId: string; now?: Date },
): Promise<ResolveOutcome> {
  const now = input.now ?? new Date();
  const identity = await db.identity.findFirst({
    where: { id: input.identityId, deletedAt: null },
  });
  if (!identity) throw new Error('identity not found');
  if (identity.personRecordId)
    return { action: 'already_linked', personRecordId: identity.personRecordId };

  const subject = identitySubject(identity);
  const candidates = await candidatePersonsForIdentity(db, actor.workspaceId, identity);
  const rejected = new Set(
    (
      await db.mergeSuggestion.findMany({
        where: { identityId: identity.id, status: 'REJECTED' },
        select: { rightRecordId: true },
      })
    ).map((s) => s.rightRecordId),
  );
  let best: { personRecordId: string; score: PairScore } | null = null;
  for (const personRecordId of candidates) {
    if (rejected.has(personRecordId)) continue;
    const ps = await personSubject(db, personRecordId, { excludeIdentityId: identity.id });
    if (!ps) continue;
    const score = scorePair(subject, ps);
    if (!best || score.score > best.score.score) best = { personRecordId, score };
  }
  await db.identity.update({ where: { id: identity.id }, data: { resolutionAttemptedAt: now } });

  if (best && best.score.decision === 'auto') {
    const link = await linkIdentity(db, actor, {
      identityId: identity.id,
      personRecordId: best.personRecordId,
      method: toLinkMethod(best.score.method),
      confidence: best.score.score,
      evidence: { score: best.score.score, signals: best.score.signals },
    });
    return {
      action: 'linked',
      personRecordId: best.personRecordId,
      score: best.score,
      linkId: link.linkId,
    };
  }
  if (best && best.score.decision === 'suggest') {
    const s = await upsertSuggestion(db, actor.workspaceId, {
      identityId: identity.id,
      rightRecordId: best.personRecordId,
      score: best.score,
    });
    return {
      action: 'suggested',
      personRecordId: best.personRecordId,
      score: best.score,
      suggestionId: s.id,
    };
  }
  if (identity.email || identity.phone) {
    const r = await createPersonFromIdentity(db, actor, { identityId: identity.id });
    return { action: 'created', personRecordId: r.personRecordId, linkId: r.linkId };
  }
  return { action: 'unresolved', best: best?.score ?? null };
}

async function upsertSuggestion(
  db: TenantDb,
  workspaceId: string,
  input: { identityId?: string; leftRecordId?: string; rightRecordId: string; score: PairScore },
): Promise<{ id: string; created: boolean }> {
  const existing = await db.mergeSuggestion.findFirst({
    where: {
      rightRecordId: input.rightRecordId,
      ...(input.identityId
        ? { identityId: input.identityId }
        : { leftRecordId: input.leftRecordId! }),
    },
    select: { id: true, status: true },
  });
  const signals = {
    score: input.score.score,
    signals: input.score.signals,
    method: input.score.method,
  };
  if (existing) {
    if (existing.status === 'PENDING')
      await db.mergeSuggestion.update({
        where: { id: existing.id },
        data: { score: input.score.score, signals: signals as unknown as Prisma.InputJsonValue },
      });
    return { id: existing.id, created: false };
  }
  const row = await db.mergeSuggestion.create({
    data: {
      workspaceId,
      identityId: input.identityId ?? null,
      leftRecordId: input.leftRecordId ?? null,
      rightRecordId: input.rightRecordId,
      score: input.score.score,
      signals: signals as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

/** Re-score one suggestion with today's signals; promote, keep or expire it. */
export async function rescoreSuggestion(
  db: TenantDb,
  actor: Actor,
  suggestionId: string,
): Promise<{ status: SuggestionStatus; score: number; promoted: boolean }> {
  const s = await db.mergeSuggestion.findFirst({ where: { id: suggestionId } });
  if (!s || s.status !== 'PENDING')
    return { status: s?.status ?? 'EXPIRED', score: s?.score ?? 0, promoted: false };
  const right = await personSubject(db, s.rightRecordId, {
    excludeIdentityId: s.identityId ?? undefined,
  });
  if (!right) {
    await db.mergeSuggestion.update({
      where: { id: s.id },
      data: { status: 'EXPIRED', decidedAt: new Date() },
    });
    return { status: 'EXPIRED', score: s.score, promoted: false };
  }
  let score: PairScore;
  if (s.identityId) {
    const identity = await db.identity.findFirst({ where: { id: s.identityId, deletedAt: null } });
    if (!identity || identity.personRecordId) {
      await db.mergeSuggestion.update({
        where: { id: s.id },
        data: { status: 'EXPIRED', decidedAt: new Date() },
      });
      return { status: 'EXPIRED', score: s.score, promoted: false };
    }
    score = scorePair(identitySubject(identity), right);
  } else {
    const left = await personSubject(db, s.leftRecordId!);
    if (!left || (await isNeverMerge(db, s.leftRecordId!, s.rightRecordId))) {
      await db.mergeSuggestion.update({
        where: { id: s.id },
        data: { status: 'EXPIRED', decidedAt: new Date() },
      });
      return { status: 'EXPIRED', score: s.score, promoted: false };
    }
    score = scorePair(left, right);
  }
  const signals = { score: score.score, signals: score.signals, method: score.method };
  if (score.decision === 'auto') {
    await db.mergeSuggestion.update({
      where: { id: s.id },
      data: {
        score: score.score,
        signals: signals as unknown as Prisma.InputJsonValue,
        status: 'AUTO_MERGED',
        decidedAt: new Date(),
      },
    });
    if (s.identityId)
      await linkIdentity(db, actor, {
        identityId: s.identityId,
        personRecordId: s.rightRecordId,
        method: toLinkMethod(score.method),
        confidence: score.score,
        evidence: { score: score.score, signals: score.signals },
      });
    else
      await mergeRecords(db, actor, {
        winnerId: s.rightRecordId,
        loserId: s.leftRecordId!,
        suggestionId: s.id,
        reason: 'promoted by re-scoring',
      });
    return { status: 'AUTO_MERGED', score: score.score, promoted: true };
  }
  if (score.decision === 'none') {
    await db.mergeSuggestion.update({
      where: { id: s.id },
      data: {
        score: score.score,
        signals: signals as unknown as Prisma.InputJsonValue,
        status: 'EXPIRED',
        decidedAt: new Date(),
      },
    });
    return { status: 'EXPIRED', score: score.score, promoted: false };
  }
  await db.mergeSuggestion.update({
    where: { id: s.id },
    data: { score: score.score, signals: signals as unknown as Prisma.InputJsonValue },
  });
  return { status: 'PENDING', score: score.score, promoted: false };
}

/** Score one person against its likely duplicates; file suggestions or auto-merge per policy. */
export async function scanPersonForDuplicates(
  db: TenantDb,
  actor: Actor,
  recordId: string,
): Promise<{ suggested: number; merged: number }> {
  const left = await personSubject(db, recordId);
  if (!left) return { suggested: 0, merged: 0 };
  let suggested = 0;
  let merged = 0;
  for (const other of await candidatePersonsForPerson(db, actor.workspaceId, recordId)) {
    if (await isNeverMerge(db, recordId, other)) continue;
    const right = await personSubject(db, other);
    if (!right) continue;
    const score = scorePair(left, right);
    if (score.decision === 'none') continue;
    // One row per unordered pair: the lexically smaller id is "left".
    const [l, r] = [recordId, other].sort() as [string, string];
    if (score.decision === 'auto') {
      const stillActive = await db.record.findFirst({
        where: { id: l, mergeState: 'ACTIVE' },
        select: { id: true },
      });
      if (!stillActive) continue;
      const s = await upsertSuggestion(db, actor.workspaceId, {
        leftRecordId: l,
        rightRecordId: r,
        score,
      });
      await db.mergeSuggestion.update({
        where: { id: s.id },
        data: { status: 'AUTO_MERGED', decidedAt: new Date() },
      });
      await mergeRecords(db, actor, {
        winnerId: r,
        loserId: l,
        suggestionId: s.id,
        reason: 'automatic (tier-1 signal)',
      });
      merged += 1;
      return { suggested, merged };
    }
    const s = await upsertSuggestion(db, actor.workspaceId, {
      leftRecordId: l,
      rightRecordId: r,
      score,
    });
    if (s.created) suggested += 1;
  }
  return { suggested, merged };
}

export function toLinkMethod(m: LinkMethodName): LinkMethod {
  return m;
}

export function methodLabel(m: LinkMethod): string {
  switch (m) {
    case 'EXACT_EMAIL':
      return 'same e-mail';
    case 'PHONE':
      return 'same phone';
    case 'OAUTH_SELF':
      return 'connected by the person';
    case 'DOMAIN':
      return 'company domain and name';
    case 'NAME_FUZZY':
      return 'similar name';
    case 'HANDLE_MATCH':
      return 'matching handle';
    case 'MANUAL':
      return 'linked by a teammate';
    case 'AI_INFERRED':
      return 'inferred';
    case 'PLATFORM_PROVIDED':
      return 'reported by the platform';
  }
}

export function platformName(p: string): string {
  return (
    {
      FACEBOOK: 'Facebook',
      INSTAGRAM: 'Instagram',
      X: 'X',
      LINKEDIN: 'LinkedIn',
      TIKTOK: 'TikTok',
      YOUTUBE: 'YouTube',
      GOOGLE: 'Google',
      KEITARO: 'Keitaro',
      MOCK: 'Mock',
    }[p] ?? p
  );
}
