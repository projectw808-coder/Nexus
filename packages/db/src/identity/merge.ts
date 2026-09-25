/**
 * Reversible record merge (spec §10, §6.6 decision 2, ADR-002). The loser is never destroyed:
 * it is marked MERGED with `mergedIntoId`, every row that moved is listed in the
 * `RecordMerge.snapshot`, and `unmergeRecords` replays that snapshot in reverse inside one
 * transaction — including timeline attribution and field survivorship.
 *
 * Field survivorship: a value the winner lacks is taken from the loser; when both have one
 * and they differ, the more recently updated record's value wins and the other is kept as an
 * alternate (readable through `alternatesFor`, shown in the field's history popover).
 */
import { NexusError } from '@nexus/core';
import type { SuggestionStatus } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Actor, TenantDb } from '../scoped.ts';
import { emitTimelineEvent } from './timeline.ts';

export type MergeSnapshot = {
  version: 1;
  winner: { valuesBefore: Record<string, unknown>; updatedAt: string };
  loser: { valuesBefore: Record<string, unknown>; updatedAt: string };
  /** Per attribute: what the winner had, what the loser had, and which one survived. */
  fields: {
    attributeId: string;
    winnerBefore: unknown;
    loserValue: unknown;
    applied: 'kept_winner' | 'took_loser';
  }[];
  identities: string[];
  identityLinks: string[];
  conversations: string[];
  timelineEvents: string[];
  listEntries: { id: string; action: 'reparented' | 'deleted' }[];
  relations: { id: string; action: 'reparented' | 'deleted' }[];
  tasks: string[];
  notes: string[];
  suggestions: { id: string; status: SuggestionStatus }[];
  neverMergeRevoked: string[];
  /** Rows this merge created; deleted on unmerge. */
  createdEvents: string[];
};

export type MergeResult = {
  mergeId: string;
  winnerId: string;
  loserId: string;
  snapshot: MergeSnapshot;
};

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Merge `loserId` into `winnerId`. Both must be active records of the same object type. */
export async function mergeRecords(
  db: TenantDb,
  actor: Actor,
  input: {
    winnerId: string;
    loserId: string;
    reason?: string | null;
    suggestionId?: string | null;
  },
): Promise<MergeResult> {
  if (input.winnerId === input.loserId)
    throw new NexusError('VALIDATION', {
      context: { reason: 'A record cannot be merged with itself.' },
    });
  const [winner, loser] = await Promise.all([
    db.record.findFirst({ where: { id: input.winnerId, deletedAt: null } }),
    db.record.findFirst({ where: { id: input.loserId, deletedAt: null } }),
  ]);
  if (!winner || !loser) throw new NexusError('NOT_FOUND');
  if (winner.objectTypeId !== loser.objectTypeId)
    throw new NexusError('VALIDATION', {
      context: { reason: 'Only records of the same object can be merged.' },
    });
  if (winner.mergeState !== 'ACTIVE' || loser.mergeState !== 'ACTIVE')
    throw new NexusError('CONFLICT', {
      context: { reason: 'One of these records is already part of a merge.' },
    });

  const wv = winner.values as Record<string, unknown>;
  const lv = loser.values as Record<string, unknown>;
  const snapshot: MergeSnapshot = {
    version: 1,
    winner: { valuesBefore: wv, updatedAt: winner.updatedAt.toISOString() },
    loser: { valuesBefore: lv, updatedAt: loser.updatedAt.toISOString() },
    fields: [],
    identities: [],
    identityLinks: [],
    conversations: [],
    timelineEvents: [],
    listEntries: [],
    relations: [],
    tasks: [],
    notes: [],
    suggestions: [],
    neverMergeRevoked: [],
    createdEvents: [],
  };

  // ── Field survivorship ────────────────────────────────────────────────────
  const merged: Record<string, unknown> = { ...wv };
  const loserNewer = loser.updatedAt > winner.updatedAt;
  for (const [k, lval] of Object.entries(lv)) {
    if (k === '_unmapped') {
      const a = typeof wv[k] === 'object' && wv[k] ? (wv[k] as Record<string, unknown>) : {};
      const b = typeof lval === 'object' && lval ? (lval as Record<string, unknown>) : {};
      merged[k] = { ...b, ...a };
      continue;
    }
    if (isEmpty(lval)) continue;
    const wval = wv[k];
    if (isEmpty(wval)) {
      merged[k] = lval;
      snapshot.fields.push({
        attributeId: k,
        winnerBefore: wval ?? null,
        loserValue: lval,
        applied: 'took_loser',
      });
    } else if (!sameJson(wval, lval)) {
      if (loserNewer) {
        merged[k] = lval;
        snapshot.fields.push({
          attributeId: k,
          winnerBefore: wval,
          loserValue: lval,
          applied: 'took_loser',
        });
      } else {
        snapshot.fields.push({
          attributeId: k,
          winnerBefore: wval,
          loserValue: lval,
          applied: 'kept_winner',
        });
      }
    }
  }

  // ── Reparent children ─────────────────────────────────────────────────────
  const ids = async (rows: Promise<{ id: string }[]>) => (await rows).map((r) => r.id);
  snapshot.identities = await ids(
    db.identity.findMany({ where: { personRecordId: loser.id }, select: { id: true } }),
  );
  snapshot.identityLinks = await ids(
    db.identityLink.findMany({ where: { personRecordId: loser.id }, select: { id: true } }),
  );
  snapshot.conversations = await ids(
    db.conversation.findMany({ where: { personRecordId: loser.id }, select: { id: true } }),
  );
  snapshot.timelineEvents = await ids(
    db.timelineEvent.findMany({ where: { recordId: loser.id }, select: { id: true } }),
  );
  snapshot.tasks = await ids(
    db.task.findMany({ where: { recordId: loser.id }, select: { id: true } }),
  );
  snapshot.notes = await ids(
    db.note.findMany({ where: { recordId: loser.id }, select: { id: true } }),
  );

  if (snapshot.identities.length)
    await db.identity.updateMany({
      where: { id: { in: snapshot.identities } },
      data: { personRecordId: winner.id },
    });
  if (snapshot.identityLinks.length)
    await db.identityLink.updateMany({
      where: { id: { in: snapshot.identityLinks } },
      data: { personRecordId: winner.id },
    });
  if (snapshot.conversations.length)
    await db.conversation.updateMany({
      where: { id: { in: snapshot.conversations } },
      data: { personRecordId: winner.id },
    });
  if (snapshot.timelineEvents.length)
    await db.timelineEvent.updateMany({
      where: { id: { in: snapshot.timelineEvents } },
      data: { recordId: winner.id },
    });
  if (snapshot.tasks.length)
    await db.task.updateMany({
      where: { id: { in: snapshot.tasks } },
      data: { recordId: winner.id },
    });
  if (snapshot.notes.length)
    await db.note.updateMany({
      where: { id: { in: snapshot.notes } },
      data: { recordId: winner.id },
    });

  // List entries: the winner keeps its own entry in a list both are in; the loser's is retired.
  const loserEntries = await db.listEntry.findMany({
    where: { recordId: loser.id, deletedAt: null },
    select: { id: true, listId: true },
  });
  const winnerLists = new Set(
    (
      await db.listEntry.findMany({
        where: { recordId: winner.id, deletedAt: null },
        select: { listId: true },
      })
    ).map((e) => e.listId),
  );
  for (const e of loserEntries) {
    if (winnerLists.has(e.listId)) {
      await db.listEntry.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
      snapshot.listEntries.push({ id: e.id, action: 'deleted' });
    } else {
      await db.listEntry.update({ where: { id: e.id }, data: { recordId: winner.id } });
      snapshot.listEntries.push({ id: e.id, action: 'reparented' });
    }
  }

  // Relations: reparent unless the winner already has the identical edge.
  const loserRelations = await db.recordRelation.findMany({
    where: { OR: [{ fromRecordId: loser.id }, { toRecordId: loser.id }], deletedAt: null },
  });
  for (const rel of loserRelations) {
    const from = rel.fromRecordId === loser.id ? winner.id : rel.fromRecordId;
    const to = rel.toRecordId === loser.id ? winner.id : rel.toRecordId;
    const dup =
      from === to
        ? true
        : Boolean(
            await db.recordRelation.findFirst({
              where: {
                fromRecordId: from,
                toRecordId: to,
                attributeId: rel.attributeId,
                deletedAt: null,
                id: { not: rel.id },
              },
              select: { id: true },
            }),
          );
    if (dup) {
      await db.recordRelation.update({ where: { id: rel.id }, data: { deletedAt: new Date() } });
      snapshot.relations.push({ id: rel.id, action: 'deleted' });
    } else {
      await db.recordRelation.update({
        where: { id: rel.id },
        data: { fromRecordId: from, toRecordId: to },
      });
      snapshot.relations.push({ id: rel.id, action: 'reparented' });
    }
  }

  // Suggestions that involved the loser are settled; the one being accepted is marked so.
  const suggestions = await db.mergeSuggestion.findMany({
    where: {
      OR: [{ leftRecordId: loser.id }, { rightRecordId: loser.id }],
      status: 'PENDING',
    },
    select: { id: true, status: true },
  });
  for (const s of suggestions) {
    snapshot.suggestions.push({ id: s.id, status: s.status });
    await db.mergeSuggestion.update({
      where: { id: s.id },
      data: {
        status: s.id === input.suggestionId ? 'ACCEPTED' : 'EXPIRED',
        decidedById: actor.userId,
        decidedAt: new Date(),
      },
    });
  }
  // A "never merge" pair for these two is overridden by an explicit merge.
  const nm = await db.neverMerge.findMany({
    where: {
      deletedAt: null,
      OR: [
        { leftRecordId: winner.id, rightRecordId: loser.id },
        { leftRecordId: loser.id, rightRecordId: winner.id },
      ],
    },
    select: { id: true },
  });
  for (const n of nm) {
    await db.neverMerge.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
    snapshot.neverMergeRevoked.push(n.id);
  }

  // ── The records themselves ────────────────────────────────────────────────
  await db.record.update({
    where: { id: winner.id },
    data: { values: merged as Prisma.InputJsonValue },
  });
  await db.record.update({
    where: { id: loser.id },
    data: { mergeState: 'MERGED', mergedIntoId: winner.id },
  });

  const merge = await db.recordMerge.create({
    data: {
      workspaceId: actor.workspaceId,
      winnerId: winner.id,
      loserId: loser.id,
      mergedById: actor.userId,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const ev = await emitTimelineEvent(db, {
    workspaceId: actor.workspaceId,
    dedupeKey: `merge:${merge.id}`,
    type: 'SYSTEM',
    occurredAt: new Date(),
    recordId: winner.id,
    actorUserId: actor.userId,
    summary: `Merged with a duplicate record${input.reason ? ` — ${input.reason}` : ''}`,
    payload: {
      kind: 'merge',
      mergeId: merge.id,
      loserId: loser.id,
      fields: snapshot.fields.length,
      identities: snapshot.identities.length,
      timelineEvents: snapshot.timelineEvents.length,
    },
  });
  snapshot.createdEvents.push(ev.id);
  await db.recordMerge.update({
    where: { id: merge.id },
    data: { snapshot: snapshot as unknown as Prisma.InputJsonValue },
  });
  return { mergeId: merge.id, winnerId: winner.id, loserId: loser.id, snapshot };
}

export type UnmergeResult = {
  mergeId: string;
  winnerId: string;
  loserId: string;
  neverMergeId: string | null;
};

/**
 * Replay the snapshot in reverse. Rows created on the winner after the merge stay with the
 * winner; a field the user edited after the merge keeps the edit (only values that still
 * equal the merged-in value are restored).
 */
export async function unmergeRecords(
  db: TenantDb,
  actor: Actor,
  input: { mergeId: string; neverMerge?: boolean; reason?: string | null },
): Promise<UnmergeResult> {
  const merge = await db.recordMerge.findFirst({ where: { id: input.mergeId } });
  if (!merge) throw new NexusError('NOT_FOUND');
  if (merge.unmergedAt)
    throw new NexusError('CONFLICT', { context: { reason: 'This merge was already undone.' } });
  const snapshot = merge.snapshot as unknown as MergeSnapshot;
  const winner = await db.record.findFirstOrThrow({ where: { id: merge.winnerId } });
  if (winner.mergeState !== 'ACTIVE')
    throw new NexusError('CONFLICT', {
      context: { reason: 'Undo the later merge of this record first.' },
    });

  // Values: restore each survivorship decision only where the merged-in value still stands.
  const values: Record<string, unknown> = { ...(winner.values as Record<string, unknown>) };
  for (const f of snapshot.fields) {
    if (f.applied !== 'took_loser') continue;
    if (!sameJson(values[f.attributeId], f.loserValue)) continue;
    if (isEmpty(f.winnerBefore)) delete values[f.attributeId];
    else values[f.attributeId] = f.winnerBefore;
  }
  if ('_unmapped' in snapshot.winner.valuesBefore)
    values['_unmapped'] = snapshot.winner.valuesBefore['_unmapped'];
  else if ('_unmapped' in values && !('_unmapped' in snapshot.winner.valuesBefore))
    delete values['_unmapped'];
  await db.record.update({
    where: { id: winner.id },
    data: { values: values as Prisma.InputJsonValue },
  });
  await db.record.update({
    where: { id: merge.loserId },
    data: {
      mergeState: 'ACTIVE',
      mergedIntoId: null,
      values: snapshot.loser.valuesBefore as Prisma.InputJsonValue,
    },
  });

  const back = merge.loserId;
  if (snapshot.identities.length)
    await db.identity.updateMany({
      where: { id: { in: snapshot.identities } },
      data: { personRecordId: back },
    });
  if (snapshot.identityLinks.length)
    await db.identityLink.updateMany({
      where: { id: { in: snapshot.identityLinks } },
      data: { personRecordId: back },
    });
  if (snapshot.conversations.length)
    await db.conversation.updateMany({
      where: { id: { in: snapshot.conversations } },
      data: { personRecordId: back },
    });
  if (snapshot.timelineEvents.length)
    await db.timelineEvent.updateMany({
      where: { id: { in: snapshot.timelineEvents } },
      data: { recordId: back },
    });
  if (snapshot.tasks.length)
    await db.task.updateMany({ where: { id: { in: snapshot.tasks } }, data: { recordId: back } });
  if (snapshot.notes.length)
    await db.note.updateMany({ where: { id: { in: snapshot.notes } }, data: { recordId: back } });
  for (const e of snapshot.listEntries)
    await db.listEntry.update({
      where: { id: e.id },
      data: e.action === 'deleted' ? { deletedAt: null } : { recordId: back },
    });
  for (const r of snapshot.relations) {
    if (r.action === 'deleted') {
      await db.recordRelation.update({ where: { id: r.id }, data: { deletedAt: null } });
    } else {
      const rel = await db.recordRelation.findFirstOrThrow({ where: { id: r.id } });
      // The edge pointed at the loser on whichever side now points at the winner.
      await db.recordRelation.update({
        where: { id: r.id },
        data: {
          ...(rel.fromRecordId === winner.id ? { fromRecordId: back } : {}),
          ...(rel.toRecordId === winner.id ? { toRecordId: back } : {}),
        },
      });
    }
  }
  for (const s of snapshot.suggestions)
    await db.mergeSuggestion.update({
      where: { id: s.id },
      data: { status: s.status, decidedById: null, decidedAt: null },
    });
  if (snapshot.neverMergeRevoked.length)
    await db.neverMerge.updateMany({
      where: { id: { in: snapshot.neverMergeRevoked } },
      data: { deletedAt: null },
    });
  if (snapshot.createdEvents.length)
    await db.timelineEvent.deleteMany({ where: { id: { in: snapshot.createdEvents } } });

  await db.recordMerge.update({
    where: { id: merge.id },
    data: { unmergedAt: new Date(), unmergedById: actor.userId },
  });

  let neverMergeId: string | null = null;
  if (input.neverMerge ?? true) {
    const [left, right] = [merge.winnerId, merge.loserId].sort();
    const existing = await db.neverMerge.findFirst({
      where: { leftRecordId: left!, rightRecordId: right!, deletedAt: null },
      select: { id: true },
    });
    neverMergeId =
      existing?.id ??
      (
        await db.neverMerge.create({
          data: {
            workspaceId: actor.workspaceId,
            leftRecordId: left!,
            rightRecordId: right!,
            decidedById: actor.userId,
            reason: input.reason ?? 'Unmerged',
          },
          select: { id: true },
        })
      ).id;
  }
  return { mergeId: merge.id, winnerId: merge.winnerId, loserId: merge.loserId, neverMergeId };
}

export type Alternate = { value: unknown; fromRecordId: string; mergeId: string; mergedAt: Date };

/** Alternate values the winner's active merges kept for each attribute (field history popover). */
export async function alternatesFor(
  db: TenantDb,
  recordId: string,
): Promise<Record<string, Alternate[]>> {
  const merges = await db.recordMerge.findMany({
    where: { winnerId: recordId, unmergedAt: null },
    orderBy: { mergedAt: 'desc' },
    select: { id: true, loserId: true, mergedAt: true, snapshot: true },
  });
  const out: Record<string, Alternate[]> = {};
  for (const m of merges) {
    const snap = m.snapshot as unknown as MergeSnapshot;
    for (const f of snap.fields) {
      const alt = f.applied === 'took_loser' ? f.winnerBefore : f.loserValue;
      if (isEmpty(alt)) continue;
      (out[f.attributeId] ??= []).push({
        value: alt,
        fromRecordId: f.applied === 'took_loser' ? recordId : m.loserId,
        mergeId: m.id,
        mergedAt: m.mergedAt,
      });
    }
  }
  return out;
}

/** Is this ordered-independent pair marked "never merge"? */
export async function isNeverMerge(db: TenantDb, a: string, b: string): Promise<boolean> {
  const [left, right] = [a, b].sort();
  const row = await db.neverMerge.findFirst({
    where: { leftRecordId: left!, rightRecordId: right!, deletedAt: null },
    select: { id: true },
  });
  return Boolean(row);
}
