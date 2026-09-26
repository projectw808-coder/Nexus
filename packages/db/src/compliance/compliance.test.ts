/**
 * Phase 11 — the compliance layer (§5.5, ADR-022).
 *
 * The acceptance criterion this file exists for: "A DSAR erasure removes every trace of a person
 * across all channels and leaves a tombstone." A person is seeded with identities on two
 * platforms, conversations, messages, timeline events, notes, tasks, AI insights, embeddings,
 * consent, merge evidence and raw external objects; the erasure job runs; every one of those rows
 * must be gone, the `DataSubjectRequest` must survive with a tombstone that names what went, and
 * an unrelated person in the same workspace must be untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../scoped.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { loadAttributes } from '../objects/attributes.ts';
import { createRecord } from '../objects/records.ts';
import { personAttributes } from '../identity/subjects.ts';
import { getConsent, recordConsent, consentAllowsSend, listConsent } from './consent.ts';
import { purgeConnectionRetention } from './retention.ts';
import { runDataSubjectRequest } from './dsr.ts';
import {
  MemoryExportStorage,
  S3ExportStorage,
  getExportStorage,
  setExportStorage,
} from './storage.ts';
import {
  PLATFORM_COMPLIANCE_NOTES,
  listComplianceNotes,
  seedPlatformComplianceNotes,
} from './notes.ts';

let db: TestDatabase;
let actor: Actor;
let ws: { id: string };
let userId: string;
let igConnectionId: string;
let xConnectionId: string;
let personTypeId: string;
let nameAttrId: string;
let emailAttrId: string;

const T = (day: string) => new Date(`2026-09-${day}T10:00:00.000Z`);

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@acme.test', name: 'Owner' } });
  userId = u.id;
  ws = await db.tenancy.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: u.id });
  actor = { workspaceId: ws.id, userId: u.id, role: 'OWNER', grants: [] };
  await db.runtime.withTenant(actor, async (t) => {
    const pa = await personAttributes(t);
    personTypeId = pa.objectTypeId;
    nameAttrId = pa.ids.name!;
    emailAttrId = pa.ids.email!;
    for (const [platform, accountExternalId, label] of [
      ['INSTAGRAM', 'ig_acme', 'Instagram — Acme'],
      ['X', 'x_acme', 'X — Acme'],
    ] as const) {
      const c = await t.connection.create({
        data: {
          workspaceId: ws.id,
          platform,
          label,
          accountExternalId,
          accountName: 'Acme',
          apiVersion: 'v1',
          tokenRef: 'vault:test',
          ownerUserId: u.id,
          scopesGranted: [],
          scopesRequired: [],
          capabilities: [],
        },
        select: { id: true },
      });
      if (platform === 'INSTAGRAM') igConnectionId = c.id;
      else xConnectionId = c.id;
    }
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

// ── fixture: one person, spread across two platforms ────────────────────────

type Seeded = {
  recordId: string;
  igIdentityId: string;
  xIdentityId: string;
  igConversationId: string;
  xConversationId: string;
  groupConversationId: string;
  otherIdentityId: string;
  messageIds: string[];
  eventIds: string[];
  noteIds: string[];
  taskId: string;
  insightIds: string[];
  externalObjectIds: string[];
};

async function seedPerson(email: string): Promise<Seeded> {
  return db.runtime.withTenant(actor, async (t) => {
    const record = await createRecord(t, actor, {
      objectTypeId: personTypeId,
      attributes: await loadAttributes(t, personTypeId),
      input: { [nameAttrId]: 'Dana Ray', [emailAttrId]: email },
    });
    const recordId = record.id;

    const ig = await t.identity.create({
      data: {
        workspaceId: ws.id,
        platform: 'INSTAGRAM',
        externalId: `ig_${email}`,
        handle: 'danaray',
        displayName: 'Dana Ray',
        email,
        personRecordId: recordId,
        raw: { bio: 'likes coffee' },
      },
      select: { id: true },
    });
    const x = await t.identity.create({
      data: {
        workspaceId: ws.id,
        platform: 'X',
        externalId: `x_${email}`,
        handle: 'dana_r',
        displayName: 'Dana Ray',
        email,
        personRecordId: recordId,
      },
      select: { id: true },
    });
    // A third party who shares one thread with Dana — their messages must survive.
    const other = await t.identity.create({
      data: {
        workspaceId: ws.id,
        platform: 'INSTAGRAM',
        externalId: `ig_other_${email}`,
        handle: 'someoneelse',
        displayName: 'Someone Else',
      },
      select: { id: true },
    });

    const conv = async (
      connectionId: string,
      platform: 'INSTAGRAM' | 'X',
      externalId: string,
      identityId: string | null,
      subject: string,
    ) =>
      (
        await t.conversation.create({
          data: {
            workspaceId: ws.id,
            connectionId,
            platform,
            kind: 'DM',
            externalId,
            subject,
            identityId,
            personRecordId: identityId === null ? null : recordId,
            lastMessageAt: T('20'),
          },
          select: { id: true },
        })
      ).id;

    const igConversationId = await conv(
      igConnectionId,
      'INSTAGRAM',
      `ig_dm_${email}`,
      ig.id,
      'DM with danaray',
    );
    const xConversationId = await conv(xConnectionId, 'X', `x_dm_${email}`, x.id, 'DM with dana_r');
    const groupConversationId = await conv(
      igConnectionId,
      'INSTAGRAM',
      `ig_group_${email}`,
      ig.id,
      'Group thread with danaray',
    );

    const message = async (
      conversationId: string,
      externalId: string,
      authorIdentityId: string | null,
      body: string,
      sentAt: Date,
    ) =>
      (
        await t.message.create({
          data: {
            workspaceId: ws.id,
            conversationId,
            externalId,
            direction: authorIdentityId ? 'INBOUND' : 'OUTBOUND',
            authorIdentityId,
            ...(authorIdentityId ? {} : { authorUserId: userId }),
            body,
            sentAt,
          },
          select: { id: true },
        })
      ).id;

    const messageIds = [
      await message(igConversationId, 'm1', ig.id, 'hello from instagram', T('20')),
      await message(igConversationId, 'm2', null, 'our reply', T('20')),
      await message(xConversationId, 'm3', x.id, 'hello from x', T('20')),
      await message(groupConversationId, 'm4', ig.id, 'dana in the group', T('20')),
    ];
    const otherMessageId = await message(
      groupConversationId,
      'm5',
      other.id,
      'someone else in the group',
      T('20'),
    );

    const externalObjectIds: string[] = [];
    for (const [i, kind] of ['ig_comment', 'x_dm'].entries()) {
      const eo = await t.externalObject.create({
        data: {
          workspaceId: ws.id,
          connectionId: i === 0 ? igConnectionId : xConnectionId,
          platform: i === 0 ? 'INSTAGRAM' : 'X',
          kind,
          externalId: `eo_${kind}_${email}`,
          raw: { text: 'the platform payload about Dana', from: 'danaray' },
          apiVersion: 'v1',
          contentHash: `h_${kind}_${email}`,
          fetchedAt: T('20'),
        },
        select: { id: true },
      });
      externalObjectIds.push(eo.id);
    }

    const eventIds: string[] = [];
    for (const [i, identityId] of [ig.id, x.id].entries()) {
      const e = await t.timelineEvent.create({
        data: {
          workspaceId: ws.id,
          recordId,
          identityId,
          type: 'MESSAGE',
          platform: i === 0 ? 'INSTAGRAM' : 'X',
          connectionId: i === 0 ? igConnectionId : xConnectionId,
          occurredAt: T('20'),
          summary: `Dana said something on ${i === 0 ? 'Instagram' : 'X'}`,
          dedupeKey: `ev_${i}_${email}`,
          externalObjectId: externalObjectIds[i]!,
        },
        select: { id: true },
      });
      eventIds.push(e.id);
    }

    const noteIds: string[] = [];
    for (const [target, body] of [
      [{ recordId }, 'internal note about Dana'],
      [{ conversationId: igConversationId }, 'note on the IG thread'],
    ] as const) {
      const n = await t.note.create({
        data: { workspaceId: ws.id, ...target, authorId: userId, body },
        select: { id: true },
      });
      noteIds.push(n.id);
    }

    const task = await t.task.create({
      data: {
        workspaceId: ws.id,
        title: 'Follow up with Dana',
        recordId,
        assigneeId: userId,
        createdById: userId,
      },
      select: { id: true },
    });

    const insightIds: string[] = [];
    for (const target of [{ recordId }, { conversationId: igConversationId }]) {
      const ai = await t.aiInsight.create({
        data: {
          workspaceId: ws.id,
          ...target,
          kind: 'SUMMARY',
          content: { text: 'Dana is a happy customer' },
          model: 'test-model',
          promptVersion: 'v1',
          confidence: 0.9,
        },
        select: { id: true },
      });
      insightIds.push(ai.id);
    }

    // Embeddings: soft references, so nothing cascades them.
    for (const [sourceType, sourceId] of [
      ['message', messageIds[0]!],
      ['note', noteIds[0]!],
      ['record', recordId],
    ] as const) {
      await t.$executeRaw`INSERT INTO "Embedding" ("id","workspaceId","sourceType","sourceId","vector","model","chunkIndex","text","createdAt","updatedAt")
        VALUES (gen_random_uuid(), ${ws.id}, ${sourceType}, ${sourceId}, ${`[${Array(1536).fill(0).join(',')}]`}::vector, 'test-model', 0, 'chunk', now(), now())`;
    }

    // Identity resolution evidence.
    await t.identityLink.create({
      data: {
        workspaceId: ws.id,
        identityId: ig.id,
        personRecordId: recordId,
        method: 'EXACT_EMAIL',
        confidence: 0.99,
        evidence: { email },
      },
    });
    await t.mergeSuggestion.create({
      data: {
        workspaceId: ws.id,
        identityId: x.id,
        rightRecordId: recordId,
        score: 0.8,
        signals: { handle: 'dana_r' },
      },
    });
    await recordConsent(t, actor, {
      identityId: ig.id,
      channel: 'INSTAGRAM',
      status: 'GRANTED',
      source: 'lead_form',
    });

    // Sanity: the third party's message really is in the group thread.
    expect(otherMessageId).toBeTruthy();

    return {
      recordId,
      igIdentityId: ig.id,
      xIdentityId: x.id,
      igConversationId,
      xConversationId,
      groupConversationId,
      otherIdentityId: other.id,
      messageIds,
      eventIds,
      noteIds,
      taskId: task.id,
      insightIds,
      externalObjectIds,
    };
  });
}

const count = (model: string, where: Record<string, unknown>): Promise<number> =>
  db.runtime.withSystem((s) =>
    (s as unknown as Record<string, { count(a: unknown): Promise<number> }>)[model]!.count({
      where,
    }),
  );

// ── 1. the acceptance criterion ─────────────────────────────────────────────

describe('DSAR erasure (§5.5, §16 Phase 11)', () => {
  it('removes every trace of a person across all channels and leaves a tombstone', async () => {
    const dana = await seedPerson('dana@example.test');
    const bystander = await seedPerson('other-person@example.test');

    const request = await db.runtime.withTenant(actor, (t) =>
      t.dataSubjectRequest.create({
        data: {
          workspaceId: ws.id,
          kind: 'ERASURE',
          subjectEmail: 'dana@example.test',
          subjectRecordId: dana.recordId,
          requestedById: userId,
        },
        select: { id: true },
      }),
    );

    const result = await runDataSubjectRequest(db.runtime, {
      workspaceId: ws.id,
      requestId: request.id,
      now: T('26'),
    });
    expect(result.status).toBe('COMPLETED');

    // Every row that was Dana's is gone — checked with RLS bypassed, so this is what really exists.
    expect(await count('record', { id: dana.recordId })).toBe(0);
    expect(await count('identity', { id: { in: [dana.igIdentityId, dana.xIdentityId] } })).toBe(0);
    expect(await count('message', { id: { in: dana.messageIds } })).toBe(0);
    expect(await count('timelineEvent', { id: { in: dana.eventIds } })).toBe(0);
    expect(await count('note', { id: { in: dana.noteIds } })).toBe(0);
    expect(await count('task', { id: dana.taskId })).toBe(0);
    expect(await count('aiInsight', { id: { in: dana.insightIds } })).toBe(0);
    expect(await count('externalObject', { id: { in: dana.externalObjectIds } })).toBe(0);
    expect(
      await count('embedding', { sourceId: { in: [dana.recordId, dana.messageIds[0]!] } }),
    ).toBe(0);
    expect(await count('identityLink', { identityId: dana.igIdentityId })).toBe(0);
    expect(await count('mergeSuggestion', { identityId: dana.xIdentityId })).toBe(0);
    expect(await count('consentRecord', { identityId: dana.igIdentityId })).toBe(0);
    // Exclusive threads go outright.
    expect(
      await count('conversation', { id: { in: [dana.igConversationId, dana.xConversationId] } }),
    ).toBe(0);

    // The shared thread survives as a shell with nothing of Dana's in it, and the third party's
    // message is still there — a blanket cascade would have destroyed someone else's data.
    const group = await db.runtime.withSystem((s) =>
      s.conversation.findFirst({
        where: { id: dana.groupConversationId },
        select: { id: true, identityId: true, personRecordId: true, subject: true },
      }),
    );
    expect(group).not.toBeNull();
    expect(group!.identityId).toBeNull();
    expect(group!.personRecordId).toBeNull();
    expect(group!.subject).toBe('[erased]');
    expect(await count('message', { conversationId: dana.groupConversationId })).toBe(1);
    expect(await count('identity', { id: dana.otherIdentityId })).toBe(1);

    // The request itself survives as an auditable record, with a tombstone that proves what went.
    const after = await db.runtime.withSystem((s) =>
      s.dataSubjectRequest.findFirstOrThrow({ where: { id: request.id } }),
    );
    expect(after.status).toBe('COMPLETED');
    expect(after.completedAt).not.toBeNull();
    const tombstone = after.tombstone as {
      erasedAt: string;
      subject: { recordId: string; identityIds: string[] };
      removed: { table: string; count: number; ids?: string[] }[];
    };
    expect(tombstone.subject.recordId).toBe(dana.recordId);
    expect(tombstone.subject.identityIds).toHaveLength(2);
    const byTable = new Map(tombstone.removed.map((r) => [r.table, r]));
    for (const table of [
      'Identity',
      'Record',
      'Message',
      'TimelineEvent',
      'Note',
      'AiInsight',
      'ExternalObject',
      'Embedding',
      'Conversation',
      'ConsentRecord',
      'IdentityLink',
      'MergeSuggestion',
      'Task',
    ]) {
      expect(byTable.get(table)?.count ?? 0).toBeGreaterThan(0);
    }
    expect(byTable.get('Identity')!.ids).toEqual(
      expect.arrayContaining([dana.igIdentityId, dana.xIdentityId]),
    );
    // A tombstone that held the erased content would defeat the point: no bodies, only counts/ids.
    expect(JSON.stringify(tombstone)).not.toContain('hello from instagram');
    expect(JSON.stringify(tombstone)).not.toContain('the platform payload about Dana');

    // One audit row per table, not per row, plus the start/complete pair.
    const audit = await db.runtime.withSystem((s) =>
      s.auditLog.findMany({
        where: { targetId: request.id },
        select: { action: true, targetType: true, diff: true },
      }),
    );
    expect(audit.some((a) => a.action === 'dsr.started')).toBe(true);
    expect(audit.some((a) => a.action === 'dsr.erasure_completed')).toBe(true);
    const perTable = audit.filter((a) => a.action === 'dsr.erasure_rows_deleted');
    expect(perTable.length).toBe(tombstone.removed.length);
    expect(new Set(perTable.map((a) => a.targetType)).size).toBe(perTable.length);

    // The unrelated person in the same workspace is untouched.
    expect(await count('record', { id: bystander.recordId })).toBe(1);
    expect(await count('message', { id: { in: bystander.messageIds } })).toBe(
      bystander.messageIds.length,
    );
    expect(await count('timelineEvent', { id: { in: bystander.eventIds } })).toBe(
      bystander.eventIds.length,
    );
    expect(await count('externalObject', { id: { in: bystander.externalObjectIds } })).toBe(
      bystander.externalObjectIds.length,
    );
  }, 180_000);

  it('is idempotent: a second run reports the request already finished', async () => {
    const dana = await seedPerson('dana2@example.test');
    const request = await db.runtime.withTenant(actor, (t) =>
      t.dataSubjectRequest.create({
        data: { workspaceId: ws.id, kind: 'ERASURE', subjectRecordId: dana.recordId },
        select: { id: true },
      }),
    );
    await runDataSubjectRequest(db.runtime, { workspaceId: ws.id, requestId: request.id });
    const again = await runDataSubjectRequest(db.runtime, {
      workspaceId: ws.id,
      requestId: request.id,
    });
    expect(again.skipped).toMatch(/already COMPLETED/);
  }, 120_000);
});

// ── 2. DSAR export ──────────────────────────────────────────────────────────

describe('DSAR export (kind ACCESS / PORTABILITY)', () => {
  it('produces a portable JSON export, parks it, and stops at EXPORT_READY for a human', async () => {
    const dana = await seedPerson('export@example.test');
    const storage = new MemoryExportStorage();
    const request = await db.runtime.withTenant(actor, (t) =>
      t.dataSubjectRequest.create({
        data: {
          workspaceId: ws.id,
          kind: 'PORTABILITY',
          subjectEmail: 'export@example.test',
          subjectRecordId: dana.recordId,
        },
        select: { id: true },
      }),
    );

    const result = await runDataSubjectRequest(
      db.runtime,
      { workspaceId: ws.id, requestId: request.id, now: T('26') },
      storage,
    );
    expect(result.status).toBe('EXPORT_READY');
    expect(result.exportRef).toBe(`memory://dsr/${ws.id}/${request.id}.json`);

    const document = JSON.parse(await storage.get(result.exportRef!)) as {
      format: string;
      identities: { platform: string }[];
      messages: { body: string }[];
      externalObjects: { raw: unknown }[];
      consent: { channel: string }[];
    };
    expect(document.format).toBe('nexus.dsr.export/1');
    expect(document.identities.map((i) => i.platform).sort()).toEqual(['INSTAGRAM', 'X']);
    expect(document.messages.some((m) => m.body === 'hello from instagram')).toBe(true);
    expect(document.messages.some((m) => m.body === 'hello from x')).toBe(true);
    // Dana's own message in the group thread is hers; the third party's is not.
    expect(document.messages.some((m) => m.body === 'dana in the group')).toBe(true);
    expect(document.messages.some((m) => m.body === 'someone else in the group')).toBe(false);
    expect(document.externalObjects).toHaveLength(2);
    expect(document.consent.map((c) => c.channel)).toContain('INSTAGRAM');

    // Nothing was deleted by an access request.
    expect(await count('record', { id: dana.recordId })).toBe(1);
    const row = await db.runtime.withSystem((s) =>
      s.dataSubjectRequest.findFirstOrThrow({ where: { id: request.id } }),
    );
    expect(row.status).toBe('EXPORT_READY');
    expect(row.exportRef).toBe(result.exportRef);
  }, 120_000);

  it('leaves a rectification request alone — that is a record edit, not a job', async () => {
    const request = await db.runtime.withTenant(actor, (t) =>
      t.dataSubjectRequest.create({
        data: { workspaceId: ws.id, kind: 'RECTIFICATION', subjectEmail: 'nobody@example.test' },
        select: { id: true },
      }),
    );
    const result = await runDataSubjectRequest(db.runtime, {
      workspaceId: ws.id,
      requestId: request.id,
    });
    expect(result.status).toBe('RECEIVED');
    expect(result.skipped).toMatch(/rectification/);
  });
});

// ── 3. retention purge ──────────────────────────────────────────────────────

describe('retention purge (Connection.retentionDays)', () => {
  it('deletes only rows older than the window and leaves in-window rows standing', async () => {
    const now = T('26');
    const old = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // outside a 1-day window
    const fresh = new Date(now.getTime() - 60 * 60 * 1000); // inside it

    const seeded = await db.runtime.withTenant(actor, async (t) => {
      await t.connection.update({
        where: { id: igConnectionId },
        data: { retentionDays: 1 },
      });
      const conv = await t.conversation.create({
        data: {
          workspaceId: ws.id,
          connectionId: igConnectionId,
          platform: 'INSTAGRAM',
          kind: 'DM',
          externalId: 'retention_thread',
          lastMessageAt: now,
        },
        select: { id: true },
      });
      const mk = async (externalId: string, sentAt: Date) =>
        (
          await t.message.create({
            data: {
              workspaceId: ws.id,
              conversationId: conv.id,
              externalId,
              direction: 'INBOUND',
              body: 'body',
              sentAt,
            },
            select: { id: true },
          })
        ).id;
      const eo = async (externalId: string, fetchedAt: Date) =>
        (
          await t.externalObject.create({
            data: {
              workspaceId: ws.id,
              connectionId: igConnectionId,
              platform: 'INSTAGRAM',
              kind: 'ig_comment',
              externalId,
              raw: {},
              apiVersion: 'v1',
              contentHash: `h_${externalId}`,
              fetchedAt,
            },
            select: { id: true },
          })
        ).id;
      const ev = async (dedupeKey: string, occurredAt: Date) =>
        (
          await t.timelineEvent.create({
            data: {
              workspaceId: ws.id,
              type: 'MESSAGE',
              platform: 'INSTAGRAM',
              connectionId: igConnectionId,
              occurredAt,
              summary: 'something happened',
              dedupeKey,
            },
            select: { id: true },
          })
        ).id;
      return {
        oldMessage: await mk('r_old', old),
        freshMessage: await mk('r_fresh', fresh),
        oldObject: await eo('r_old_eo', old),
        freshObject: await eo('r_fresh_eo', fresh),
        oldEvent: await ev('r_old_ev', old),
        freshEvent: await ev('r_fresh_ev', fresh),
      };
    });

    const result = await purgeConnectionRetention(db.runtime, now);
    const purge = result.purged.find((p) => p.connectionId === igConnectionId);
    expect(purge).toBeDefined();
    expect(purge!.retentionDays).toBe(1);

    expect(await count('message', { id: seeded.oldMessage })).toBe(0);
    expect(await count('message', { id: seeded.freshMessage })).toBe(1);
    expect(await count('externalObject', { id: seeded.oldObject })).toBe(0);
    expect(await count('externalObject', { id: seeded.freshObject })).toBe(1);
    expect(await count('timelineEvent', { id: seeded.oldEvent })).toBe(0);
    expect(await count('timelineEvent', { id: seeded.freshEvent })).toBe(1);

    // One audit row for the connection, carrying the counts — never one per deleted row.
    const audit = await db.runtime.withSystem((s) =>
      s.auditLog.findMany({
        where: { action: 'retention.purged', targetId: igConnectionId },
        select: { diff: true },
      }),
    );
    expect(audit).toHaveLength(1);
    expect((audit[0]!.diff as { total: number }).total).toBeGreaterThanOrEqual(3);

    // A connection with no policy is never touched.
    expect(result.purged.some((p) => p.connectionId === xConnectionId)).toBe(false);

    await db.runtime.withTenant(actor, (t) =>
      t.connection.update({ where: { id: igConnectionId }, data: { retentionDays: null } }),
    );
  }, 120_000);
});

// ── 4. consent ──────────────────────────────────────────────────────────────

describe('consent tracking (ADR-022 decision 3)', () => {
  it('round-trips, defaults to UNKNOWN, and audits every change', async () => {
    const dana = await seedPerson('consent@example.test');
    await db.runtime.withTenant(actor, async (t) => {
      // No row at all: UNKNOWN, never a throw.
      expect(await getConsent(t, dana.xIdentityId, 'X')).toBe('UNKNOWN');
      expect(await getConsent(t, dana.xIdentityId, 'email')).toBe('UNKNOWN');

      await recordConsent(t, actor, {
        identityId: dana.xIdentityId,
        channel: 'X',
        status: 'GRANTED',
        source: 'lead_form',
      });
      expect(await getConsent(t, dana.xIdentityId, 'X')).toBe('GRANTED');

      // Upsert on the unique key: withdrawing does not create a second row.
      await recordConsent(t, actor, {
        identityId: dana.xIdentityId,
        channel: 'X',
        status: 'WITHDRAWN',
        source: 'unsubscribe_link',
      });
      expect(await getConsent(t, dana.xIdentityId, 'X')).toBe('WITHDRAWN');
      expect(await t.consentRecord.count({ where: { identityId: dana.xIdentityId } })).toBe(1);

      const withdrawals = await listConsent(t, { status: 'WITHDRAWN' });
      expect(withdrawals.some((r) => r.identityId === dana.xIdentityId)).toBe(true);
    });

    const audit = await db.runtime.withSystem((s) =>
      s.auditLog.findMany({
        where: { action: { in: ['consent.recorded', 'consent.withdrawn'] } },
        select: { action: true, diff: true },
      }),
    );
    expect(audit.some((a) => a.action === 'consent.withdrawn')).toBe(true);
    expect(audit.some((a) => (a.diff as { from?: string }).from === 'GRANTED')).toBe(true);
  }, 120_000);

  it('blocks an unprompted send only when consent was WITHDRAWN', async () => {
    const dana = await seedPerson('gate@example.test');
    await db.runtime.withTenant(actor, async (t) => {
      // UNKNOWN proceeds (ADR-022 decision 3 — the default is not a block).
      const unknown = await consentAllowsSend(t, {
        kind: 'conversation',
        conversationId: dana.xConversationId,
      });
      expect(unknown).toMatchObject({ allowed: true, status: 'UNKNOWN', channel: 'X' });

      await recordConsent(t, actor, {
        identityId: dana.xIdentityId,
        channel: 'X',
        status: 'WITHDRAWN',
      });
      const blocked = await consentAllowsSend(t, {
        kind: 'conversation',
        conversationId: dana.xConversationId,
      });
      expect(blocked.allowed).toBe(false);
      expect(blocked.identityId).toBe(dana.xIdentityId);
      expect(blocked.reason).toMatch(/withdrawn/i);

      // GRANTED proceeds.
      await recordConsent(t, actor, {
        identityId: dana.igIdentityId,
        channel: 'INSTAGRAM',
        status: 'GRANTED',
      });
      const allowed = await consentAllowsSend(t, {
        kind: 'conversation',
        conversationId: dana.igConversationId,
      });
      expect(allowed).toMatchObject({ allowed: true, status: 'GRANTED' });

      // An email target resolves through Identity.email; an unknown address is not blocked.
      await recordConsent(t, actor, {
        identityId: dana.igIdentityId,
        channel: 'email',
        status: 'WITHDRAWN',
      });
      const byEmail = await consentAllowsSend(t, { kind: 'email', email: 'gate@example.test' });
      expect(byEmail.allowed).toBe(false);
      expect(byEmail.channel).toBe('email');
      const stranger = await consentAllowsSend(t, { kind: 'email', email: 'nobody@example.test' });
      expect(stranger).toMatchObject({ allowed: true, identityId: null });
    });
  }, 120_000);
});

// ── 5. platform compliance notes ────────────────────────────────────────────

describe('PlatformComplianceNote seed', () => {
  it('seeds idempotently and is queryable for a workspace’s connected platforms', async () => {
    const first = await seedPlatformComplianceNotes(db.runtime);
    expect(first.created).toBe(PLATFORM_COMPLIANCE_NOTES.length);
    const second = await seedPlatformComplianceNotes(db.runtime);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(PLATFORM_COMPLIANCE_NOTES.length);

    const notes = await db.runtime.withTenant(actor, async (t) => {
      const connected = await t.connection.findMany({
        where: { deletedAt: null },
        select: { platform: true },
      });
      return listComplianceNotes(t, [...new Set(connected.map((c) => c.platform))]);
    });
    expect(notes.length).toBeGreaterThan(0);
    // Only the platforms this workspace actually connected (Instagram + X here).
    expect(new Set(notes.map((n) => n.platform))).toEqual(new Set(['INSTAGRAM', 'X']));
    for (const n of notes) {
      expect(n.title.length).toBeGreaterThan(0);
      expect(n.body.length).toBeGreaterThan(40);
      expect(n.sourceUrl).toMatch(/^https:\/\//);
    }
    // One note per platform for every platform this product connects to.
    const platforms: string[] = PLATFORM_COMPLIANCE_NOTES.map((n) => n.platform);
    for (const p of ['FACEBOOK', 'INSTAGRAM', 'X', 'LINKEDIN', 'TIKTOK', 'YOUTUBE', 'KEITARO']) {
      expect(platforms).toContain(p);
    }
  }, 120_000);
});

// ── 6. the export-storage seam ──────────────────────────────────────────────

describe('ExportStorage', () => {
  beforeEach(() => setExportStorage(undefined));

  it('defaults to the in-memory store in tests and honours the test hook', async () => {
    expect(getExportStorage()).toBeInstanceOf(MemoryExportStorage);
    const injected = new MemoryExportStorage();
    setExportStorage(injected);
    expect(getExportStorage()).toBe(injected);
    const { ref } = await injected.put('k/1.json', '{"a":1}');
    expect(await injected.get(ref)).toBe('{"a":1}');
    await expect(injected.get('memory://missing')).rejects.toThrow('export not found');
    setExportStorage(undefined);
  });

  it('signs an S3 PUT with a well-formed SigV4 authorization', () => {
    const s3 = new S3ExportStorage({
      endpoint: 'http://localhost:9000',
      bucket: 'nexus',
      accessKey: 'minio',
      secretKey: 'minio-secret',
      region: 'us-east-1',
      forcePathStyle: true,
    });
    const at = new Date('2026-09-26T12:00:00.000Z');
    const { url, headers } = s3.sign('PUT', 'dsr/ws/req.json', '{"a":1}', at);
    expect(url).toBe('http://localhost:9000/nexus/dsr/ws/req.json');
    expect(headers['x-amz-date']).toBe('20260926T120000Z');
    expect(headers['Authorization']).toContain(
      'Credential=minio/20260926/us-east-1/s3/aws4_request',
    );
    expect(headers['Authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['Authorization']).toMatch(/Signature=[0-9a-f]{64}$/);
    // Deterministic for a fixed clock and payload; a different payload changes the signature.
    expect(s3.sign('PUT', 'dsr/ws/req.json', '{"a":1}', at).headers['Authorization']).toBe(
      headers['Authorization'],
    );
    expect(s3.sign('PUT', 'dsr/ws/req.json', '{"a":2}', at).headers['Authorization']).not.toBe(
      headers['Authorization'],
    );
    // Virtual-host style puts the bucket in the host instead of the path.
    const vhost = new S3ExportStorage({
      endpoint: 'https://s3.example.com',
      bucket: 'nexus',
      accessKey: 'k',
      secretKey: 's',
      region: 'eu-west-1',
      forcePathStyle: false,
    });
    expect(vhost.sign('GET', 'dsr/ws/req.json', null, at).url).toBe(
      'https://nexus.s3.example.com/dsr/ws/req.json',
    );
  });
});
