/**
 * Phase 6 (spec §10, §6.3, ADR-002/003/017): tiered resolution with evidence, the timeline
 * union, identity → person backfill without duplication, and merge → unmerge exactness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../scoped.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { loadAttributes } from '../objects/attributes.ts';
import { createRecord } from '../objects/records.ts';
import { addEntry, createList } from '../objects/lists.ts';
import { upsertIdentity } from './identities.ts';
import { alternatesFor, mergeRecords, unmergeRecords } from './merge.ts';
import {
  createPersonFromIdentity,
  linkIdentity,
  rescoreSuggestion,
  resolveIdentity,
  scanPersonForDuplicates,
  unlinkIdentity,
} from './resolve.ts';
import { personAttributes } from './subjects.ts';
import { emitTimelineEvent, queryTimeline } from './timeline.ts';

let db: TestDatabase;
/** Unscoped reads for assertions: RLS applies to the app role, so go through withSystem. */
type AnyDelegate = Record<string, (args: unknown) => Promise<unknown>>;
const sysdb = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      new Proxy(
        {},
        {
          get: (_m, op: string) => (args: unknown) =>
            db.runtime.withSystem((s) =>
              (s as unknown as Record<string, AnyDelegate>)[model]![op]!(args),
            ),
        },
      ),
  },
) as unknown as TestDatabase['prisma'];
let actor: Actor;
let ws: { id: string };
let connectionId: string;
let personTypeId: string;
let A: { name: string; email: string; phone: string; company: string };

const T = (s: string) => new Date(`2026-09-${s}`);

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@acme.test', name: 'Owner' } });
  ws = await db.tenancy.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: u.id });
  actor = { workspaceId: ws.id, userId: u.id, role: 'OWNER', grants: [] };
  await db.runtime.withTenant(actor, async (t) => {
    const pa = await personAttributes(t);
    personTypeId = pa.objectTypeId;
    A = {
      name: pa.ids.name!,
      email: pa.ids.email!,
      phone: pa.ids.phone!,
      company: pa.ids.company!,
    };
    const c = await t.connection.create({
      data: {
        workspaceId: ws.id,
        platform: 'INSTAGRAM',
        label: 'Instagram — Acme',
        accountExternalId: 'ig_acme',
        accountName: 'Acme',
        apiVersion: 'v26.0',
        tokenRef: 'vault:test',
        ownerUserId: u.id,
        scopesGranted: [],
        scopesRequired: [],
        capabilities: [],
      },
      select: { id: true },
    });
    connectionId = c.id;
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const person = (values: Record<string, unknown>) =>
  db.runtime.withTenant(actor, async (t) =>
    createRecord(t, actor, {
      objectTypeId: personTypeId,
      attributes: await loadAttributes(t, personTypeId),
      input: values,
    }),
  );

type IdentitySeed = {
  platform: 'FACEBOOK' | 'INSTAGRAM' | 'X' | 'LINKEDIN' | 'TIKTOK' | 'MOCK';
  externalId: string;
  handle?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  profileUrl?: string;
  bio?: string;
  locale?: string;
};

const identity = (s: IdentitySeed, seenAt = T('01T10:00:00Z')) =>
  db.runtime.withTenant(actor, (t) =>
    upsertIdentity(t, {
      workspaceId: ws.id,
      platform: s.platform,
      externalId: s.externalId,
      seenAt,
      handle: s.handle ?? null,
      displayName: s.displayName ?? null,
      email: s.email ?? null,
      phone: s.phone ?? null,
      profileUrl: s.profileUrl ?? null,
      canonical: { bio: s.bio ?? null, locale: s.locale ?? null },
    }),
  );

const event = (
  identityId: string,
  at: Date,
  summary: string,
  extra: Record<string, unknown> = {},
) =>
  db.runtime.withTenant(actor, (t) =>
    emitTimelineEvent(t, {
      workspaceId: ws.id,
      dedupeKey: `ev:${identityId}:${summary}`,
      type: 'MESSAGE',
      occurredAt: at,
      identityId,
      actorIdentityId: identityId,
      platform: 'INSTAGRAM',
      connectionId,
      summary,
      ...extra,
    }),
  );

describe('identities', () => {
  it('a handle change is kept in raw and shows up as a timeline event', async () => {
    const first = await identity({
      platform: 'X',
      externalId: 'x_1',
      handle: 'old_handle',
      displayName: 'Sam',
    });
    expect(first.created).toBe(true);
    const second = await identity(
      { platform: 'X', externalId: 'x_1', handle: 'new_handle' },
      T('02T10:00:00Z'),
    );
    expect(second.created).toBe(false);
    expect(second.handleChange).toEqual({ from: 'old_handle', to: 'new_handle' });
    const row = await sysdb.identity.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.handle).toBe('new_handle');
    expect(row.displayName).toBe('Sam');
    const history = (row.raw as { _handleHistory: { handle: string; to: string | null }[] })
      ._handleHistory;
    expect(history.map((h) => h.handle)).toEqual(['old_handle', 'new_handle']);
    expect(history[0]!.to).not.toBeNull();
    const tl = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, identityId: first.id }),
    );
    expect(tl.items.map((e) => [e.type, e.summary])).toEqual([
      ['SYSTEM', 'Changed handle from @old_handle to @new_handle'],
    ]);
  });

  it('timeline events are idempotent on their dedupe key', async () => {
    const i = await identity({ platform: 'TIKTOK', externalId: 'tt_dup' });
    const a = await event(i.id, T('03T10:00:00Z'), 'hi');
    const b = await event(i.id, T('03T10:00:00Z'), 'hi');
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });
});

describe('resolution', () => {
  it('links five channel identities to one person and keeps the timeline chronological', async () => {
    const jordan = await person({
      [A.name]: 'Jordan Rivera',
      [A.email]: 'jordan@rivera.dev',
      [A.phone]: '+15551230100',
    });
    const seeds: IdentitySeed[] = [
      {
        platform: 'FACEBOOK',
        externalId: 'fb_j',
        displayName: 'Jordan Rivera',
        email: 'jordan@rivera.dev',
      },
      {
        platform: 'INSTAGRAM',
        externalId: 'ig_j',
        handle: 'jordan.rivera',
        displayName: 'Jordan Rivera',
        profileUrl: 'https://instagram.com/jordan.rivera',
      },
      {
        platform: 'X',
        externalId: 'x_j',
        handle: 'jordan.rivera',
        displayName: 'Jordan Rivera',
        bio: 'photos → instagram.com/jordan.rivera',
      },
      {
        platform: 'LINKEDIN',
        externalId: 'li_j',
        displayName: 'Jordan Rivera',
        phone: '555-123-0100',
      },
      {
        platform: 'TIKTOK',
        externalId: 'tt_j',
        handle: 'jordan.rivera',
        displayName: 'Jordan Rivera',
      },
    ];
    const ids: string[] = [];
    for (const s of seeds) ids.push((await identity(s)).id);
    // Activity on each identity before resolution, out of order.
    await event(ids[1]!, T('05T09:00:00Z'), 'IG comment');
    await event(ids[0]!, T('04T09:00:00Z'), 'FB message');
    await event(ids[4]!, T('06T09:00:00Z'), 'TikTok comment');
    await event(ids[2]!, T('03T09:00:00Z'), 'X mention');
    await event(ids[3]!, T('07T09:00:00Z'), 'LinkedIn message');

    const outcomes = [];
    for (const id of ids)
      outcomes.push(
        await db.runtime.withTenant(actor, (t) => resolveIdentity(t, actor, { identityId: id })),
      );
    // FB: e-mail (tier 1). IG: handle corroborated by name + (nothing else) → after FB linked, the
    // person carries the FB display name… still one tier-2 → suggest; but the X bio link to the IG
    // profile makes IG + X reinforce each other once one of them is on the person. Order matters,
    // so assert the policy rather than a fixed sequence.
    expect(outcomes[0]!.action).toBe('linked');
    expect(outcomes[3]!.action).toBe('linked'); // phone, tier 1
    const linked = await sysdb.identity.findMany({ where: { personRecordId: jordan.id } });
    const suggestions = await sysdb.mergeSuggestion.findMany({
      where: { rightRecordId: jordan.id, status: 'PENDING' },
    });
    // Whatever was not auto-linked is waiting in the queue with its evidence.
    expect(linked.length + suggestions.length).toBe(5);
    for (const s of suggestions) {
      const signals = (s.signals as { signals: { label: string }[] }).signals;
      expect(signals.length).toBeGreaterThan(0);
    }
    // A teammate accepts the rest: every suggestion links, with the evidence carried over.
    for (const s of suggestions) {
      const score = s.signals as { score: number; signals: never[]; method: 'HANDLE_MATCH' };
      await db.runtime.withTenant(actor, (t) =>
        linkIdentity(t, actor, {
          identityId: s.identityId!,
          personRecordId: s.rightRecordId,
          method: 'MANUAL',
          confidence: score.score,
          evidence: { score: score.score, signals: score.signals },
          confirmed: true,
        }),
      );
    }
    const chips = await sysdb.identity.findMany({
      where: { personRecordId: jordan.id },
      orderBy: { platform: 'asc' },
    });
    expect(chips.map((c) => c.platform).sort()).toEqual([
      'FACEBOOK',
      'INSTAGRAM',
      'LINKEDIN',
      'TIKTOK',
      'X',
    ]);
    const links = await sysdb.identityLink.findMany({
      where: { personRecordId: jordan.id, revokedAt: null },
    });
    expect(links).toHaveLength(5);
    for (const l of links) expect(l.confidence).toBeGreaterThanOrEqual(0.4);

    const tl = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, recordId: jordan.id, types: ['MESSAGE'] }),
    );
    expect(tl.items.map((e) => e.summary)).toEqual([
      'LinkedIn message',
      'TikTok comment',
      'IG comment',
      'FB message',
      'X mention',
    ]);
    // Every one of those rows now carries the record id — a single batched backfill, no copies.
    const rows = await sysdb.timelineEvent.findMany({
      where: { identityId: { in: ids }, type: 'MESSAGE' },
    });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.recordId === jordan.id)).toBe(true);
    expect(tl.facets.types['MESSAGE']).toBe(5);
    expect(tl.facets.types['SYSTEM']).toBe(5); // five link events
  });

  it('an unresolved identity keeps its own visible history until it resolves; then it moves once', async () => {
    const i = await identity({
      platform: 'INSTAGRAM',
      externalId: 'ig_unknown',
      handle: 'mystery.guest',
    });
    await event(i.id, T('08T09:00:00Z'), 'first comment');
    await event(i.id, T('09T09:00:00Z'), 'second comment');
    const conv = await db.runtime.withTenant(actor, (t) =>
      t.conversation.create({
        data: {
          workspaceId: ws.id,
          connectionId,
          platform: 'INSTAGRAM',
          kind: 'COMMENT_THREAD',
          externalId: 'thread_mystery',
          identityId: i.id,
          lastMessageAt: T('09T09:00:00Z'),
        },
        select: { id: true },
      }),
    );
    const unresolved = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: i.id }),
    );
    expect(unresolved.action).toBe('unresolved');
    const own = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, identityId: i.id }),
    );
    expect(own.items.map((e) => e.summary)).toEqual(['second comment', 'first comment']);

    const p = await person({ [A.name]: 'Mystery Guest' });
    const before = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, recordId: p.id }),
    );
    expect(before.items).toHaveLength(0);
    const link = await db.runtime.withTenant(actor, (t) =>
      linkIdentity(t, actor, {
        identityId: i.id,
        personRecordId: p.id,
        method: 'MANUAL',
        confidence: 1,
        evidence: { score: 1, signals: [], note: 'they told us' },
        confirmed: true,
      }),
    );
    expect(link.backfilled).toEqual({ timelineEvents: 2, conversations: 1 });
    const after = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, recordId: p.id, types: ['MESSAGE'] }),
    );
    expect(after.items.map((e) => e.summary)).toEqual(['second comment', 'first comment']);
    expect(after.items.every((e) => e.provenance === 'identity')).toBe(true);
    expect(await sysdb.timelineEvent.count({ where: { identityId: i.id, type: 'MESSAGE' } })).toBe(
      2,
    );
    expect(
      (await sysdb.conversation.findUniqueOrThrow({ where: { id: conv.id } })).personRecordId,
    ).toBe(p.id);

    // Unlink sends it all back to the identity.
    await db.runtime.withTenant(actor, (t) => unlinkIdentity(t, actor, { identityId: i.id }));
    const gone = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, recordId: p.id, types: ['MESSAGE'] }),
    );
    expect(gone.items).toHaveLength(0);
    expect(
      (await sysdb.conversation.findUniqueOrThrow({ where: { id: conv.id } })).personRecordId,
    ).toBeNull();
  });

  it('an identity with an e-mail but no match becomes a new person', async () => {
    const i = await identity({
      platform: 'FACEBOOK',
      externalId: 'fb_lead',
      displayName: 'Lea Form',
      email: 'lea@example.org',
    });
    const r = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: i.id }),
    );
    expect(r.action).toBe('created');
    const rec = await sysdb.record.findUniqueOrThrow({
      where: { id: (r as { personRecordId: string }).personRecordId },
    });
    expect(rec.values).toMatchObject({ [A.name]: 'Lea Form', [A.email]: 'lea@example.org' });
    const again = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: i.id }),
    );
    expect(again.action).toBe('already_linked');
  });

  it('a rejected suggestion is never re-filed; new evidence promotes a pending one', async () => {
    const p = await person({ [A.name]: 'Casey Stone' });
    const i = await identity({
      platform: 'X',
      externalId: 'x_casey',
      handle: 'caseystone',
      displayName: 'Casey Stone',
    });
    const r = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: i.id }),
    );
    expect(r.action).toBe('suggested');
    const sid = (r as { suggestionId: string }).suggestionId;
    // New signal arrives: the identity now carries the person's e-mail.
    await db.runtime.withTenant(actor, (t) =>
      t.record.update({
        where: { id: p.id },
        data: { values: { [A.name]: 'Casey Stone', [A.email]: 'casey@stone.io' } },
      }),
    );
    await identity({ platform: 'X', externalId: 'x_casey', email: 'casey@stone.io' });
    const rescored = await db.runtime.withTenant(actor, (t) => rescoreSuggestion(t, actor, sid));
    expect(rescored).toMatchObject({ status: 'AUTO_MERGED', promoted: true, score: 1 });
    expect((await sysdb.identity.findUniqueOrThrow({ where: { id: i.id } })).personRecordId).toBe(
      p.id,
    );

    const q = await person({ [A.name]: 'Quinn Park' });
    const j = await identity({
      platform: 'TIKTOK',
      externalId: 'tt_quinn',
      handle: 'quinnpark',
      displayName: 'Quinn Park',
    });
    const s1 = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: j.id }),
    );
    expect(s1.action).toBe('suggested');
    await sysdb.mergeSuggestion.update({
      where: { id: (s1 as { suggestionId: string }).suggestionId },
      data: { status: 'REJECTED' },
    });
    const s2 = await db.runtime.withTenant(actor, (t) =>
      resolveIdentity(t, actor, { identityId: j.id }),
    );
    expect(s2.action).toBe('unresolved');
    expect(await sysdb.mergeSuggestion.count({ where: { identityId: j.id } })).toBe(1);
    void q;
  });

  it('createPersonFromIdentity copies what the identity knows', async () => {
    const i = await identity({
      platform: 'LINKEDIN',
      externalId: 'li_new',
      displayName: 'Nia Okafor',
      phone: '+442079460000',
    });
    const r = await db.runtime.withTenant(actor, (t) =>
      createPersonFromIdentity(t, actor, { identityId: i.id }),
    );
    const rec = await sysdb.record.findUniqueOrThrow({ where: { id: r.personRecordId } });
    expect(rec.values).toMatchObject({ [A.name]: 'Nia Okafor', [A.phone]: '+442079460000' });
    const link = await sysdb.identityLink.findFirstOrThrow({ where: { id: r.linkId } });
    expect(link.method).toBe('PHONE');
    expect(link.confirmedById).toBe(actor.userId);
  });
});

describe('merge → unmerge', () => {
  /** Everything about a pair of records that a merge may touch, comparable across the round trip. */
  async function snapshotOf(recordIds: string[]) {
    const ids = { in: recordIds };
    const pick = <T extends { id: string }>(rows: T[]) =>
      rows.sort((a, b) => a.id.localeCompare(b.id));
    return {
      records: pick(
        (await sysdb.record.findMany({ where: { id: ids } })).map((r) => ({
          id: r.id,
          values: r.values,
          mergeState: r.mergeState,
          mergedIntoId: r.mergedIntoId,
          deletedAt: r.deletedAt,
        })),
      ),
      identities: pick(
        (await sysdb.identity.findMany({ where: { personRecordId: ids } })).map((i) => ({
          id: i.id,
          personRecordId: i.personRecordId,
        })),
      ),
      links: pick(
        (await sysdb.identityLink.findMany({ where: { personRecordId: ids } })).map((l) => ({
          id: l.id,
          personRecordId: l.personRecordId,
          revokedAt: l.revokedAt,
        })),
      ),
      conversations: pick(
        (await sysdb.conversation.findMany({ where: { personRecordId: ids } })).map((c) => ({
          id: c.id,
          personRecordId: c.personRecordId,
        })),
      ),
      events: pick(
        (await sysdb.timelineEvent.findMany({ where: { recordId: ids } })).map((e) => ({
          id: e.id,
          recordId: e.recordId,
          identityId: e.identityId,
          summary: e.summary,
        })),
      ),
      entries: pick(
        (await sysdb.listEntry.findMany({ where: { recordId: ids } })).map((e) => ({
          id: e.id,
          recordId: e.recordId,
          listId: e.listId,
          deletedAt: e.deletedAt,
        })),
      ),
      relations: pick(
        (
          await sysdb.recordRelation.findMany({
            where: { OR: [{ fromRecordId: ids }, { toRecordId: ids }] },
          })
        ).map((r) => ({
          id: r.id,
          from: r.fromRecordId,
          to: r.toRecordId,
          deletedAt: r.deletedAt,
        })),
      ),
      notes: pick(
        (await sysdb.note.findMany({ where: { recordId: ids } })).map((n) => ({
          id: n.id,
          recordId: n.recordId,
        })),
      ),
      tasks: pick(
        (await sysdb.task.findMany({ where: { recordId: ids } })).map((n) => ({
          id: n.id,
          recordId: n.recordId,
        })),
      ),
      suggestions: pick(
        (
          await sysdb.mergeSuggestion.findMany({
            where: { OR: [{ leftRecordId: ids }, { rightRecordId: ids }] },
          })
        ).map((s) => ({ id: s.id, status: s.status })),
      ),
    };
  }

  it('is explainable, moves everything to the winner, and unmerge restores the exact pre-merge state', async () => {
    const company = await db.runtime.withTenant(actor, async (t) => {
      const ct = await t.objectType.findFirstOrThrow({ where: { apiSlug: 'company' } });
      return createRecord(t, actor, {
        objectTypeId: ct.id,
        attributes: await loadAttributes(t, ct.id),
        input: { name: 'Rivera Studio', domain: 'rivera.dev' },
      });
    });
    const winner = await person({
      [A.name]: 'Alex Kim',
      [A.email]: 'alex@kim.example',
      [A.company]: [company.id],
    });
    const loser = await person({
      [A.name]: 'Alex Kim',
      [A.email]: 'akim@rivera.dev',
      [A.phone]: '+15550001111',
      [A.company]: [company.id],
    });
    const wi = await identity({
      platform: 'INSTAGRAM',
      externalId: 'ig_alex',
      handle: 'alexkim',
      email: 'alex@kim.example',
    });
    const li = await identity({
      platform: 'X',
      externalId: 'x_akim',
      handle: 'a_kim',
      phone: '+15550001111',
    });
    await db.runtime.withTenant(actor, async (t) => {
      await linkIdentity(t, actor, {
        identityId: wi.id,
        personRecordId: winner.id,
        method: 'EXACT_EMAIL',
        confidence: 1,
        evidence: { score: 1, signals: [] },
      });
      await linkIdentity(t, actor, {
        identityId: li.id,
        personRecordId: loser.id,
        method: 'PHONE',
        confidence: 1,
        evidence: { score: 1, signals: [] },
      });
    });
    await event(wi.id, T('10T09:00:00Z'), 'winner dm');
    await event(li.id, T('11T09:00:00Z'), 'loser dm');
    await db.runtime.withTenant(actor, async (t) => {
      await t.conversation.create({
        data: {
          workspaceId: ws.id,
          connectionId,
          platform: 'X',
          kind: 'DM',
          externalId: 'dm_akim',
          identityId: li.id,
          personRecordId: loser.id,
          lastMessageAt: T('11T09:00:00Z'),
        },
      });
      await t.note.create({
        data: {
          workspaceId: ws.id,
          recordId: loser.id,
          body: 'loser note',
          authorId: actor.userId,
        },
      });
      await t.task.create({
        data: { workspaceId: ws.id, recordId: loser.id, title: 'loser task' },
      });
      const shared = await createList(t, actor, {
        objectTypeId: personTypeId,
        name: 'VIPs',
        kind: 'COLLECTION',
      });
      const only = await createList(t, actor, {
        objectTypeId: personTypeId,
        name: 'Newsletter',
        kind: 'COLLECTION',
      });
      await addEntry(t, actor, { listId: shared.id, recordId: winner.id });
      await addEntry(t, actor, { listId: shared.id, recordId: loser.id });
      await addEntry(t, actor, { listId: only.id, recordId: loser.id });
    });
    // The pair scores as a duplicate (same company domain + fuzzy name is tier-2/3): file it.
    const scan = await db.runtime.withTenant(actor, (t) =>
      scanPersonForDuplicates(t, actor, loser.id),
    );
    expect(scan.suggested).toBe(1);
    const suggestion = await sysdb.mergeSuggestion.findFirstOrThrow({
      where: { OR: [{ leftRecordId: loser.id }, { rightRecordId: loser.id }], status: 'PENDING' },
    });
    const why = suggestion.signals as { score: number; signals: { label: string; tier: number }[] };
    expect(why.signals.length).toBeGreaterThan(0);
    expect(why.signals.every((s) => typeof s.label === 'string')).toBe(true);

    const before = await snapshotOf([winner.id, loser.id]);
    const merge = await db.runtime.withTenant(actor, (t) =>
      mergeRecords(t, actor, {
        winnerId: winner.id,
        loserId: loser.id,
        suggestionId: suggestion.id,
      }),
    );
    // Survivorship: the winner gains the phone it lacked; on the conflicting e-mail the more
    // recently updated record (the loser) wins and the winner's value is kept as an alternate.
    const w = await sysdb.record.findUniqueOrThrow({ where: { id: winner.id } });
    expect(w.values).toMatchObject({
      [A.name]: 'Alex Kim',
      [A.email]: 'akim@rivera.dev',
      [A.phone]: '+15550001111',
    });
    const l = await sysdb.record.findUniqueOrThrow({ where: { id: loser.id } });
    expect(l).toMatchObject({ mergeState: 'MERGED', mergedIntoId: winner.id });
    const alternates = await db.runtime.withTenant(actor, (t) => alternatesFor(t, winner.id));
    expect(alternates[A.email]?.[0]?.value).toBe('alex@kim.example');
    expect(why.signals.some((sig) => sig.tier === 2)).toBe(true); // same company domain + same name
    // Everything of the loser now reads from the winner…
    expect((await sysdb.identity.findUniqueOrThrow({ where: { id: li.id } })).personRecordId).toBe(
      winner.id,
    );
    const tl = await db.runtime.withTenant(actor, (t) =>
      queryTimeline(t, { workspaceId: ws.id, recordId: winner.id, types: ['MESSAGE'] }),
    );
    expect(tl.items.map((e) => e.summary)).toEqual(['loser dm', 'winner dm']);
    expect(await sysdb.note.count({ where: { recordId: winner.id } })).toBe(1);
    expect(await sysdb.task.count({ where: { recordId: winner.id } })).toBe(1);
    expect(await sysdb.conversation.count({ where: { personRecordId: winner.id } })).toBe(1);
    const entries = await sysdb.listEntry.findMany({
      where: { recordId: winner.id, deletedAt: null },
    });
    expect(entries).toHaveLength(2); // VIPs once (loser's retired), Newsletter reparented
    expect(merge.snapshot.listEntries.map((e) => e.action).sort()).toEqual([
      'deleted',
      'reparented',
    ]);
    expect(
      (await sysdb.mergeSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })).status,
    ).toBe('ACCEPTED');
    // …and the record can explain what happened.
    expect(merge.snapshot.fields.map((f) => f.applied)).toContain('took_loser');
    expect(merge.snapshot.identities).toEqual([li.id]);

    const un = await db.runtime.withTenant(actor, (t) =>
      unmergeRecords(t, actor, { mergeId: merge.mergeId }),
    );
    expect(un.neverMergeId).not.toBeNull();
    const after = await snapshotOf([winner.id, loser.id]);
    expect(after).toEqual(before);
    const rm = await sysdb.recordMerge.findUniqueOrThrow({ where: { id: merge.mergeId } });
    expect(rm.unmergedAt).not.toBeNull();
    // The pair is now "never merge": the scan will not file it again.
    const rescan = await db.runtime.withTenant(actor, (t) =>
      scanPersonForDuplicates(t, actor, loser.id),
    );
    expect(rescan).toEqual({ suggested: 0, merged: 0 });
  });

  it('a later edit on the winner survives an unmerge; a tier-1 duplicate auto-merges', async () => {
    const a = await person({ [A.name]: 'Pat Lee', [A.phone]: '+15559990000' });
    const b = await person({ [A.name]: 'Patricia Lee', [A.phone]: '+15559990000' });
    const scan = await db.runtime.withTenant(actor, (t) => scanPersonForDuplicates(t, actor, b.id));
    expect(scan.merged).toBe(1);
    const merged = await sysdb.recordMerge.findFirstOrThrow({
      where: { OR: [{ loserId: a.id }, { loserId: b.id }], unmergedAt: null },
    });
    const winnerId = merged.winnerId;
    // Someone edits the winner's name after the merge.
    await sysdb.record.update({
      where: { id: winnerId },
      data: { values: { [A.name]: 'Patricia Lee-Wong', [A.phone]: '+15559990000' } },
    });
    await db.runtime.withTenant(actor, (t) =>
      unmergeRecords(t, actor, { mergeId: merged.id, neverMerge: false }),
    );
    const w = await sysdb.record.findUniqueOrThrow({ where: { id: winnerId } });
    expect((w.values as Record<string, unknown>)[A.name]).toBe('Patricia Lee-Wong');
    expect(
      await sysdb.neverMerge.count({
        where: { OR: [{ leftRecordId: a.id }, { rightRecordId: a.id }] },
      }),
    ).toBe(0);
  });
});
