/**
 * The unified timeline (spec §6.3, ADR-003): one stream per record, assembled from events
 * that were attached to the record directly and events that landed on one of its channel
 * identities before (or after) resolution. Every reader goes through `queryTimeline` — never a
 * bare `recordId` filter — so an unresolved identity's history is never lost and never doubled.
 */
import type { Platform, TimelineType } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';

export type TimelineEventInput = {
  workspaceId: string;
  /** Idempotency key (unique per workspace). Replays and redeliveries become no-ops. */
  dedupeKey: string;
  type: TimelineType;
  occurredAt: Date;
  summary: string;
  recordId?: string | null;
  identityId?: string | null;
  platform?: Platform | null;
  connectionId?: string | null;
  actorIdentityId?: string | null;
  actorUserId?: string | null;
  payload?: unknown;
  sourceUrl?: string | null;
  externalObjectId?: string | null;
};

/**
 * Idempotent insert: an event with the same `dedupeKey` is left untouched. When only the
 * identity is known and it is already resolved, the event lands on the person at once.
 */
export async function emitTimelineEvent(
  db: TenantDb,
  input: TimelineEventInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.timelineEvent.findFirst({
    where: { dedupeKey: input.dedupeKey },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  let recordId = input.recordId ?? null;
  if (!recordId && input.identityId) {
    const idn = await db.identity.findFirst({
      where: { id: input.identityId },
      select: { personRecordId: true },
    });
    recordId = idn?.personRecordId ?? null;
  }
  try {
    const row = await db.timelineEvent.create({
      data: {
        workspaceId: input.workspaceId,
        dedupeKey: input.dedupeKey,
        type: input.type,
        occurredAt: input.occurredAt,
        summary: input.summary.slice(0, 500),
        recordId,
        identityId: input.identityId ?? null,
        platform: input.platform ?? null,
        connectionId: input.connectionId ?? null,
        actorIdentityId: input.actorIdentityId ?? null,
        actorUserId: input.actorUserId ?? null,
        payload: toJson(input.payload),
        sourceUrl: input.sourceUrl ?? null,
        externalObjectId: input.externalObjectId ?? null,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (e) {
    // A concurrent writer won the unique race: the event exists, which is all we need.
    if (isUniqueViolation(e)) {
      const row = await db.timelineEvent.findFirstOrThrow({
        where: { dedupeKey: input.dedupeKey },
        select: { id: true },
      });
      return { id: row.id, created: false };
    }
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002';
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v)),
  ) as Prisma.InputJsonValue;
}

export type TimelineQuery = {
  workspaceId: string;
  /** Exactly one of `recordId` / `identityId`. */
  recordId?: string;
  identityId?: string;
  platforms?: Platform[];
  types?: TimelineType[];
  /** Cursor from a previous page. */
  cursor?: string | null;
  limit?: number;
};

export type TimelineRow = {
  id: string;
  type: TimelineType;
  platform: Platform | null;
  connection: { id: string; label: string; platform: Platform } | null;
  occurredAt: Date;
  summary: string;
  payload: unknown;
  sourceUrl: string | null;
  recordId: string | null;
  identity: {
    id: string;
    platform: Platform;
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  actor:
    | {
        kind: 'identity';
        id: string;
        platform: Platform;
        handle: string | null;
        displayName: string | null;
      }
    | { kind: 'user'; id: string; name: string | null; email: string }
    | null;
  /** Where this event was attached when it was written: the person, or an identity that resolved later. */
  provenance: 'record' | 'identity';
};

export type TimelinePage = {
  items: TimelineRow[];
  nextCursor: string | null;
  /** Facet counts over the unfiltered stream, for the filter chips. */
  facets: { platforms: Record<string, number>; types: Record<string, number> };
};

const IDENTITY_SELECT = {
  id: true,
  platform: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
} as const;

/** Events of a record: attached directly OR attached to one of its identities (the union). */
export async function queryTimeline(db: TenantDb, q: TimelineQuery): Promise<TimelinePage> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  let scope: Prisma.TimelineEventWhereInput;
  if (q.recordId) {
    const identities = await db.identity.findMany({
      where: { personRecordId: q.recordId, deletedAt: null },
      select: { id: true },
    });
    scope = {
      OR: [
        { recordId: q.recordId },
        ...(identities.length ? [{ identityId: { in: identities.map((i) => i.id) } }] : []),
      ],
    };
  } else if (q.identityId) {
    scope = { identityId: q.identityId };
  } else {
    return { items: [], nextCursor: null, facets: { platforms: {}, types: {} } };
  }
  const base: Prisma.TimelineEventWhereInput = { ...scope, deletedAt: null };
  const filtered: Prisma.TimelineEventWhereInput = {
    ...base,
    ...(q.platforms?.length ? { platform: { in: q.platforms } } : {}),
    ...(q.types?.length ? { type: { in: q.types } } : {}),
  };
  const cursor = decodeCursor(q.cursor);
  const rows = await db.timelineEvent.findMany({
    where: cursor
      ? {
          AND: [
            filtered,
            {
              OR: [
                { occurredAt: { lt: cursor.at } },
                { occurredAt: cursor.at, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : filtered,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      connection: { select: { id: true, label: true, platform: true } },
      identity: { select: IDENTITY_SELECT },
      actorIdentity: { select: IDENTITY_SELECT },
      actorUser: { select: { id: true, name: true, email: true } },
    },
  });
  const [byPlatform, byType] = await Promise.all([
    db.timelineEvent.groupBy({ by: ['platform'], where: base, _count: { _all: true } }),
    db.timelineEvent.groupBy({ by: ['type'], where: base, _count: { _all: true } }),
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      platform: r.platform,
      connection: r.connection,
      occurredAt: r.occurredAt,
      summary: r.summary,
      payload: r.payload,
      sourceUrl: r.sourceUrl,
      recordId: r.recordId,
      identity: r.identity,
      actor: r.actorIdentity
        ? {
            kind: 'identity',
            id: r.actorIdentity.id,
            platform: r.actorIdentity.platform,
            handle: r.actorIdentity.handle,
            displayName: r.actorIdentity.displayName,
          }
        : r.actorUser
          ? { kind: 'user', id: r.actorUser.id, name: r.actorUser.name, email: r.actorUser.email }
          : null,
      provenance: r.identityId ? 'identity' : 'record',
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    facets: {
      platforms: Object.fromEntries(byPlatform.map((g) => [g.platform ?? 'NONE', g._count._all])),
      types: Object.fromEntries(byType.map((g) => [g.type, g._count._all])),
    },
  };
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(c: string | null | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!iso || !id) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}
