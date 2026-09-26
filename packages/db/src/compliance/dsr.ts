/**
 * Data-subject requests (§5.5): find every row that belongs to one person across every channel,
 * produce a portable export, or hard-delete the lot and leave a tombstone.
 *
 * Two decisions worth stating, because both are judgement calls the spec leaves open:
 *
 *  1. **Hard delete, not soft.** `deletedAt` is not erasure — the row and its content are still
 *     in the table. Content rows (`Message`, `Note`, `TimelineEvent`, `AiInsight`,
 *     `ExternalObject`, `Embedding`, the person's `Record` and every `Identity`) are DELETEd.
 *     The only rows left standing are ones that are evidence *about* the erasure rather than
 *     content of the person: the `DataSubjectRequest` itself, its `tombstone`, and the
 *     `AuditLog` rows the job writes.
 *  2. **`ExternalObject.raw` goes too.** §2's "never discard the raw payload" is an engineering
 *     principle about not losing fidelity; a GDPR Art. 17 erasure is a legal obligation. A
 *     "raw payload" of a DM is the DM. The obligation wins: raw rows reachable from the erased
 *     person's timeline events are deleted with everything else, and the tombstone records how
 *     many, so the deletion is provable without keeping a second copy of what was deleted.
 *
 * The whole erasure runs in ONE `withTenant` transaction, so a partial failure can never leave a
 * half-erased person.
 */
import { writeAudit } from '../audit.ts';
import type { DsrKind, DsrStatus } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb, TenantRuntime } from '../scoped.ts';
import { systemActorFor } from '../sync/connections.ts';
import { getExportStorage, type ExportStorage } from './storage.ts';

// ── the subject: who this request is about ──────────────────────────────────

export type SubjectSelector = {
  subjectEmail?: string | null;
  subjectPhone?: string | null;
  subjectRecordId?: string | null;
};

export type SubjectScope = {
  /** The Person record, when the subject resolved to one. */
  recordId: string | null;
  /** Records merged INTO the subject's record — they still hold the person's pre-merge values. */
  mergedRecordIds: string[];
  /** Every channel identity that is this person. */
  identityIds: string[];
  /** Conversations this person appears in. */
  conversationIds: string[];
  /** …of those, the ones in which nobody else has spoken: safe to delete outright. */
  exclusiveConversationIds: string[];
};

/**
 * Resolve a request's selector to the actual graph. Matching is by `subjectRecordId` when given,
 * plus `email`/`phone` on `Identity` — the same signals the Tier-1 resolver (§10) trusts.
 */
export async function resolveSubjectScope(
  db: TenantDb,
  selector: SubjectSelector,
): Promise<SubjectScope> {
  const or: Prisma.IdentityWhereInput[] = [];
  if (selector.subjectRecordId) or.push({ personRecordId: selector.subjectRecordId });
  if (selector.subjectEmail) or.push({ email: selector.subjectEmail });
  if (selector.subjectPhone) or.push({ phone: selector.subjectPhone });

  const identities =
    or.length === 0
      ? []
      : await db.identity.findMany({
          where: { OR: or },
          select: { id: true, personRecordId: true },
        });

  const identityIds = identities.map((i) => i.id);
  const recordId =
    selector.subjectRecordId ?? identities.find((i) => i.personRecordId)?.personRecordId ?? null;

  // Identities attached to the resolved person but matched by neither email nor phone.
  if (recordId) {
    const more = await db.identity.findMany({
      where: { personRecordId: recordId, id: { notIn: identityIds } },
      select: { id: true },
    });
    identityIds.push(...more.map((i) => i.id));
  }

  const mergedRecordIds = recordId
    ? (await db.record.findMany({ where: { mergedIntoId: recordId }, select: { id: true } })).map(
        (r) => r.id,
      )
    : [];

  const convWhere: Prisma.ConversationWhereInput[] = [];
  if (identityIds.length > 0) convWhere.push({ identityId: { in: identityIds } });
  if (identityIds.length > 0)
    convWhere.push({ messages: { some: { authorIdentityId: { in: identityIds } } } });
  if (recordId) convWhere.push({ personRecordId: recordId });
  const conversations =
    convWhere.length === 0
      ? []
      : await db.conversation.findMany({
          where: { OR: convWhere },
          select: {
            id: true,
            // Is there anyone ELSE in this thread? A group thread may carry messages authored by
            // an identity we are not erasing — those are not this person's data to delete.
            messages: {
              where: { authorIdentityId: { notIn: identityIds.length > 0 ? identityIds : ['-'] } },
              select: { authorIdentityId: true },
              take: 1,
            },
          },
        });

  return {
    recordId,
    mergedRecordIds,
    identityIds,
    conversationIds: conversations.map((c) => c.id),
    // `notIn` does not match NULL, so a thread whose only other author is one of OUR users
    // (an outbound reply) still counts as exclusive to this person — which is right.
    exclusiveConversationIds: conversations.filter((c) => c.messages.length === 0).map((c) => c.id),
  };
}

// ── export (kind ACCESS / PORTABILITY) ──────────────────────────────────────

/**
 * Everything the subject is entitled to a copy of, as one JSON document. `ExternalObject.raw`
 * IS included: for a portability request the platform's own payload about the person is the most
 * faithful copy of their data that exists.
 */
export async function buildSubjectExport(
  db: TenantDb,
  request: { id: string; kind: DsrKind; workspaceId: string; requestedAt: Date } & SubjectSelector,
  scope: SubjectScope,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const recordIds = [...(scope.recordId ? [scope.recordId] : []), ...scope.mergedRecordIds];
  const anyIdentity = scope.identityIds.length > 0 ? scope.identityIds : ['-'];
  const anyRecord = recordIds.length > 0 ? recordIds : ['-'];
  const anyConversation = scope.conversationIds.length > 0 ? scope.conversationIds : ['-'];
  // Messages, notes and insights are pulled per-thread only for threads nobody else is in: a
  // group thread's other participants are third parties, and their words are not the subject's
  // data to receive a copy of.
  const ownThread =
    scope.exclusiveConversationIds.length > 0 ? scope.exclusiveConversationIds : ['-'];

  const [
    records,
    identities,
    conversations,
    messages,
    timeline,
    notes,
    tasks,
    insights,
    consent,
    links,
    externalObjects,
  ] = await Promise.all([
    db.record.findMany({
      where: { id: { in: anyRecord } },
      select: {
        id: true,
        values: true,
        mergeState: true,
        createdAt: true,
        objectType: { select: { apiSlug: true, singular: true } },
      },
    }),
    db.identity.findMany({
      where: { id: { in: anyIdentity } },
      select: {
        id: true,
        platform: true,
        externalId: true,
        handle: true,
        displayName: true,
        profileUrl: true,
        email: true,
        phone: true,
        raw: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    }),
    db.conversation.findMany({
      where: { id: { in: anyConversation } },
      select: {
        id: true,
        platform: true,
        kind: true,
        subject: true,
        status: true,
        lastMessageAt: true,
        createdAt: true,
      },
    }),
    db.message.findMany({
      where: {
        OR: [{ authorIdentityId: { in: anyIdentity } }, { conversationId: { in: ownThread } }],
      },
      orderBy: [{ sentAt: 'asc' }],
      select: {
        id: true,
        conversationId: true,
        direction: true,
        body: true,
        attachments: true,
        sentAt: true,
        sourceUrl: true,
      },
    }),
    db.timelineEvent.findMany({
      where: {
        OR: [{ identityId: { in: anyIdentity } }, { recordId: { in: anyRecord } }],
      },
      orderBy: [{ occurredAt: 'asc' }],
      select: {
        id: true,
        type: true,
        platform: true,
        occurredAt: true,
        summary: true,
        payload: true,
        sourceUrl: true,
        externalObjectId: true,
      },
    }),
    db.note.findMany({
      where: {
        OR: [{ recordId: { in: anyRecord } }, { conversationId: { in: ownThread } }],
      },
      select: { id: true, body: true, createdAt: true },
    }),
    db.task.findMany({
      where: { recordId: { in: anyRecord } },
      select: { id: true, title: true, description: true, status: true, dueAt: true },
    }),
    db.aiInsight.findMany({
      where: {
        OR: [{ recordId: { in: anyRecord } }, { conversationId: { in: ownThread } }],
      },
      select: { id: true, kind: true, content: true, model: true, generatedAt: true },
    }),
    db.consentRecord.findMany({
      where: { identityId: { in: anyIdentity } },
      select: { channel: true, status: true, source: true, capturedAt: true },
    }),
    db.identityLink.findMany({
      where: { identityId: { in: anyIdentity } },
      select: { identityId: true, method: true, confidence: true, evidence: true, createdAt: true },
    }),
    db.externalObject.findMany({
      where: { timelineEvents: { some: { identityId: { in: anyIdentity } } } },
      select: {
        id: true,
        platform: true,
        kind: true,
        externalId: true,
        raw: true,
        fetchedAt: true,
      },
    }),
  ]);

  return {
    format: 'nexus.dsr.export/1',
    generatedAt: now.toISOString(),
    request: {
      id: request.id,
      kind: request.kind,
      requestedAt: request.requestedAt.toISOString(),
      subject: {
        email: request.subjectEmail ?? null,
        phone: request.subjectPhone ?? null,
        recordId: request.subjectRecordId ?? null,
      },
    },
    records,
    identities,
    conversations,
    messages,
    timelineEvents: timeline,
    notes,
    tasks,
    aiInsights: insights,
    consent,
    identityLinks: links,
    externalObjects,
  };
}

// ── erasure (kind ERASURE) ──────────────────────────────────────────────────

export type TombstoneEntry = {
  table: string;
  count: number;
  /** Ids, for the small sets where they are useful evidence. Never the erased content itself. */
  ids?: string[];
};

/** Ids are evidence at small cardinality and noise at large; 50 is the line. */
const MAX_TOMBSTONE_IDS = 50;

function entry(table: string, count: number, ids?: string[]): TombstoneEntry {
  if (count === 0) return { table, count };
  return ids && ids.length > 0 && ids.length <= MAX_TOMBSTONE_IDS
    ? { table, count, ids }
    : { table, count };
}

/**
 * Erase one person. Order matters only where a delete would otherwise be blocked or would
 * cascade into someone else's data:
 *
 *  - `Embedding` first: its `sourceId` is a loose reference, not an FK, so nothing else removes it.
 *  - `Conversation`s with no other participant are deleted outright, which cascades their
 *    messages, notes and insights. Shared threads keep their shell (with `identityId` /
 *    `personRecordId` nulled and a subject that named the person redacted) and lose only this
 *    person's messages — deleting the thread would destroy a third party's messages.
 *  - the person's `Record` last: it cascades list entries, relations, tasks, notes, merge rows and
 *    timeline events, and `DataSubjectRequest.subjectRecordId` is `SetNull`, so the request row —
 *    the thing that has to survive — does.
 */
export async function eraseSubject(
  db: TenantDb,
  scope: SubjectScope,
  subjectNames: string[] = [],
): Promise<TombstoneEntry[]> {
  const anyIdentity = scope.identityIds.length > 0 ? scope.identityIds : ['-'];
  const recordIds = [...(scope.recordId ? [scope.recordId] : []), ...scope.mergedRecordIds];
  const anyRecord = recordIds.length > 0 ? recordIds : ['-'];
  const exclusive = scope.exclusiveConversationIds;
  const shared = scope.conversationIds.filter((id) => !exclusive.includes(id));

  // Rows we are about to destroy, captured first so the tombstone can name them (RecordMerge's
  // snapshot-and-restore philosophy, ADR-002 — except here nothing is kept but the proof).
  const messages = await db.message.findMany({
    where: {
      OR: [
        { authorIdentityId: { in: anyIdentity } },
        { conversationId: { in: exclusive.length > 0 ? exclusive : ['-'] } },
      ],
    },
    select: { id: true },
  });
  const notes = await db.note.findMany({
    where: {
      OR: [
        { recordId: { in: anyRecord } },
        { conversationId: { in: exclusive.length > 0 ? exclusive : ['-'] } },
      ],
    },
    select: { id: true },
  });
  const events = await db.timelineEvent.findMany({
    where: {
      OR: [
        { identityId: { in: anyIdentity } },
        { actorIdentityId: { in: anyIdentity } },
        { recordId: { in: anyRecord } },
      ],
    },
    select: { id: true, externalObjectId: true },
  });
  const externalObjectIds = [
    ...new Set(events.map((e) => e.externalObjectId).filter((id): id is string => id !== null)),
  ];

  const tombstone: TombstoneEntry[] = [];

  // 1. Embeddings — `sourceType`/`sourceId` is a soft reference; no cascade reaches these.
  const embeddingSources = [
    ...messages.map((m) => ({ sourceType: 'message', sourceId: m.id })),
    ...notes.map((n) => ({ sourceType: 'note', sourceId: n.id })),
    ...recordIds.map((id) => ({ sourceType: 'record', sourceId: id })),
    ...externalObjectIds.map((id) => ({ sourceType: 'external_object', sourceId: id })),
  ];
  const embeddings =
    embeddingSources.length === 0
      ? { count: 0 }
      : await db.embedding.deleteMany({ where: { OR: embeddingSources } });
  tombstone.push(entry('Embedding', embeddings.count));

  // 2. AI insights on the person or on their threads.
  const insights = await db.aiInsight.deleteMany({
    where: {
      OR: [
        { recordId: { in: anyRecord } },
        {
          conversationId: { in: scope.conversationIds.length > 0 ? scope.conversationIds : ['-'] },
        },
      ],
    },
  });
  tombstone.push(entry('AiInsight', insights.count));

  // 3. Notes and messages (explicitly, so they are counted even where a cascade would do it).
  const deletedNotes = await db.note.deleteMany({ where: { id: { in: notes.map((n) => n.id) } } });
  tombstone.push(
    entry(
      'Note',
      deletedNotes.count,
      notes.map((n) => n.id),
    ),
  );
  const deletedMessages = await db.message.deleteMany({
    where: { id: { in: messages.map((m) => m.id) } },
  });
  tombstone.push(
    entry(
      'Message',
      deletedMessages.count,
      messages.map((m) => m.id),
    ),
  );

  // 3b. Tasks about this person, INCLUDING ones hanging off a thread that is about to go:
  // `Task.conversationId` is `SetNull`, so a task collected after the conversation delete would
  // no longer point at anything.
  const deletedTasks = await db.task.deleteMany({
    where: {
      OR: [
        { recordId: { in: anyRecord } },
        { conversationId: { in: exclusive.length > 0 ? exclusive : ['-'] } },
      ],
    },
  });
  tombstone.push(entry('Task', deletedTasks.count));

  // 4. Timeline events, then the raw payloads behind them (see the header: erasure beats §2).
  const deletedEvents = await db.timelineEvent.deleteMany({
    where: { id: { in: events.map((e) => e.id) } },
  });
  tombstone.push(
    entry(
      'TimelineEvent',
      deletedEvents.count,
      events.map((e) => e.id),
    ),
  );
  const deletedRaw =
    externalObjectIds.length === 0
      ? { count: 0 }
      : await db.externalObject.deleteMany({ where: { id: { in: externalObjectIds } } });
  tombstone.push(entry('ExternalObject', deletedRaw.count, externalObjectIds));

  // 5. Conversations: exclusive ones go; shared ones keep a shell with nothing of this person in it.
  let redactedSubjects = 0;
  for (const id of shared) {
    const conv = await db.conversation.findFirst({ where: { id }, select: { subject: true } });
    const namesThem = subjectNames.some(
      (n) => n.length > 2 && (conv?.subject ?? '').toLowerCase().includes(n.toLowerCase()),
    );
    await db.conversation.update({
      where: { id },
      data: {
        identityId: null,
        personRecordId: null,
        ...(namesThem ? { subject: '[erased]' } : {}),
      },
    });
    if (namesThem) redactedSubjects += 1;
  }
  if (shared.length > 0) {
    tombstone.push({
      table: 'Conversation (anonymized shell)',
      count: shared.length,
      ids: shared.slice(0, MAX_TOMBSTONE_IDS),
    });
  }
  if (redactedSubjects > 0) {
    tombstone.push({ table: 'Conversation.subject (redacted)', count: redactedSubjects });
  }
  const deletedConvs =
    exclusive.length === 0
      ? { count: 0 }
      : await db.conversation.deleteMany({ where: { id: { in: exclusive } } });
  tombstone.push(entry('Conversation', deletedConvs.count, exclusive));

  // 6. Evidentiary identity rows, then the identities themselves (which cascade the rest).
  const suggestions = await db.mergeSuggestion.deleteMany({
    where: {
      OR: [
        { identityId: { in: anyIdentity } },
        { leftRecordId: { in: anyRecord } },
        { rightRecordId: { in: anyRecord } },
      ],
    },
  });
  tombstone.push(entry('MergeSuggestion', suggestions.count));
  const links = await db.identityLink.deleteMany({
    where: { OR: [{ identityId: { in: anyIdentity } }, { personRecordId: { in: anyRecord } }] },
  });
  tombstone.push(entry('IdentityLink', links.count));
  const consent = await db.consentRecord.deleteMany({
    where: { identityId: { in: anyIdentity } },
  });
  tombstone.push(entry('ConsentRecord', consent.count));
  const identities =
    scope.identityIds.length === 0
      ? { count: 0 }
      : await db.identity.deleteMany({ where: { id: { in: scope.identityIds } } });
  tombstone.push(entry('Identity', identities.count, scope.identityIds));

  // 7. The person. Cascades list entries, relations, remaining notes/events and merge rows.
  const records =
    recordIds.length === 0
      ? { count: 0 }
      : await db.record.deleteMany({ where: { id: { in: recordIds } } });
  tombstone.push(entry('Record', records.count, recordIds));

  return tombstone.filter((t) => t.count > 0);
}

// ── the job: one request, start to finish ───────────────────────────────────

export type RunDsrResult = {
  requestId: string;
  kind: DsrKind;
  status: DsrStatus;
  exportRef?: string;
  tombstone?: TombstoneEntry[];
  /** Set when the request was already finished, or is not one this job can run. */
  skipped?: string;
};

/**
 * Process one `DataSubjectRequest`. Enqueued the moment the request row is created — a person
 * filing a request should not wait for an hourly sweep.
 *
 * Status paths:
 *  - `ACCESS` / `PORTABILITY`: `RECEIVED → IN_PROGRESS → EXPORT_READY`. It stops there on
 *    purpose: handing a data export to whoever asked is the step that needs a human to verify
 *    the requester is who they say they are, so a person releases it (`COMPLETED`), not a job.
 *  - `ERASURE`: `RECEIVED → IN_PROGRESS → COMPLETED`, straight through. §5.5 requires no
 *    approval, and the approval already happened: only an owner/admin can file the request, and
 *    that act is the human decision. A second gate would just mean rows sitting in `RECEIVED`.
 *  - `RECTIFICATION`: not automated — it is an edit to a record, which the app already does
 *    through the normal (audited) record mutations. The job leaves it `RECEIVED` and says so.
 */
export async function runDataSubjectRequest(
  runtime: TenantRuntime,
  input: { workspaceId: string; requestId: string; now?: Date },
  storage: ExportStorage = getExportStorage(),
): Promise<RunDsrResult> {
  const now = input.now ?? new Date();
  const actor = systemActorFor(input.workspaceId);

  const request = await runtime.withTenant(actor, (db) =>
    db.dataSubjectRequest.findFirst({
      where: { id: input.requestId, deletedAt: null },
      select: {
        id: true,
        kind: true,
        status: true,
        workspaceId: true,
        requestedAt: true,
        subjectEmail: true,
        subjectPhone: true,
        subjectRecordId: true,
      },
    }),
  );
  if (!request) throw new Error(`data subject request ${input.requestId} not found`);
  if (request.status !== 'RECEIVED' && request.status !== 'IN_PROGRESS') {
    return {
      requestId: request.id,
      kind: request.kind,
      status: request.status,
      skipped: `already ${request.status}`,
    };
  }
  if (request.kind === 'RECTIFICATION') {
    return {
      requestId: request.id,
      kind: request.kind,
      status: request.status,
      skipped: 'rectification is a record edit, not an automated job',
    };
  }

  await runtime.withTenant(actor, async (db) => {
    await db.dataSubjectRequest.update({
      where: { id: request.id },
      data: { status: 'IN_PROGRESS' },
    });
    await writeAudit(db, actor, {
      action: 'dsr.started',
      targetType: 'DataSubjectRequest',
      targetId: request.id,
      diff: { kind: request.kind },
    });
  });

  if (request.kind === 'ERASURE') {
    // ONE transaction for the whole erasure: a partial failure rolls back completely rather
    // than leaving a person half-erased.
    const tombstone = await runtime.withTenant(
      actor,
      async (db) => {
        const scope = await resolveSubjectScope(db, request);
        const names = await redactableNames(db, scope);
        const rows = await eraseSubject(db, scope, names);
        for (const t of rows) {
          await writeAudit(db, actor, {
            action: 'dsr.erasure_rows_deleted',
            targetType: t.table,
            targetId: request.id,
            diff: { count: t.count, ...(t.ids ? { ids: t.ids } : {}) },
          });
        }
        await db.dataSubjectRequest.update({
          where: { id: request.id },
          data: {
            status: 'COMPLETED',
            completedAt: now,
            tombstone: toJson({
              erasedAt: now.toISOString(),
              subject: {
                recordId: scope.recordId,
                identityIds: scope.identityIds,
                email: request.subjectEmail,
                phone: request.subjectPhone,
              },
              removed: rows,
            }),
          },
        });
        await writeAudit(db, actor, {
          action: 'dsr.erasure_completed',
          targetType: 'DataSubjectRequest',
          targetId: request.id,
          diff: { tables: rows.length, total: rows.reduce((n, t) => n + t.count, 0) },
        });
        return rows;
      },
      { timeoutMs: 120_000 },
    );
    return { requestId: request.id, kind: request.kind, status: 'COMPLETED', tombstone };
  }

  // ACCESS / PORTABILITY
  const document = await runtime.withTenant(actor, async (db) => {
    const scope = await resolveSubjectScope(db, request);
    return buildSubjectExport(db, request, scope, now);
  });
  const content = JSON.stringify(document, null, 2);
  const { ref } = await storage.put(`dsr/${request.workspaceId}/${request.id}.json`, content);
  await runtime.withTenant(actor, async (db) => {
    await db.dataSubjectRequest.update({
      where: { id: request.id },
      data: { status: 'EXPORT_READY', exportRef: ref },
    });
    await writeAudit(db, actor, {
      action: 'dsr.export_ready',
      targetType: 'DataSubjectRequest',
      targetId: request.id,
      diff: { exportRef: ref, bytes: Buffer.byteLength(content, 'utf8') },
    });
  });
  return { requestId: request.id, kind: request.kind, status: 'EXPORT_READY', exportRef: ref };
}

/** Names/handles worth redacting out of a shared thread's subject line. */
async function redactableNames(db: TenantDb, scope: SubjectScope): Promise<string[]> {
  if (scope.identityIds.length === 0) return [];
  const rows = await db.identity.findMany({
    where: { id: { in: scope.identityIds } },
    select: { handle: true, displayName: true },
  });
  return [
    ...new Set(
      rows.flatMap((r) => [r.handle, r.displayName]).filter((s): s is string => Boolean(s)),
    ),
  ];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
