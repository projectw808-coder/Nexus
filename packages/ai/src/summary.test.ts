/**
 * The Phase 10 acceptance criteria, in one file:
 *  - "an AI summary cites real timeline events" — every id in the stored insight's `citations` is
 *    fetched back from the database and asserted to be a real TimelineEvent row for this
 *    workspace and this conversation's thread.
 *  - "the kill switch stops all model calls within one request" — the model is never called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockAiModel } from './model.ts';
import { draftReply, generateRelationshipBrief, summarizeConversation } from './summary.ts';
import { createFixture, fixedClock, settings, type Fixture } from './testing/fixtures.ts';
import type { AiDeps } from './context.ts';
import type { TenantDb } from '@nexus/db';
import type { AiSettings } from './budget.ts';
import type { MockAiModel } from './model.ts';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture('summary');
}, 120_000);
afterAll(async () => {
  await f.close();
});

function deps(db: TenantDb, model: MockAiModel, s: AiSettings = settings()): AiDeps {
  return { db, model, now: fixedClock, settings: s };
}

describe('summarizeConversation', () => {
  it('writes a SUMMARY insight whose citations are all real TimelineEvent rows', async () => {
    const model = mockAiModel();
    const result = await f.db.runtime.withTenant(f.actor, (db) =>
      summarizeConversation(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      }),
    );

    expect(model.calls.complete).toBe(1);
    expect(result.citations.length).toBeGreaterThan(0);

    // Fetch the persisted insight back and verify every stored citation independently.
    await f.db.runtime.withTenant(f.actor, async (db) => {
      const insight = await db.aiInsight.findFirstOrThrow({ where: { id: result.insightId } });
      expect(insight.kind).toBe('SUMMARY');
      expect(insight.conversationId).toBe(f.conversationId);
      expect(insight.recordId).toBe(f.personRecordId);
      expect(insight.promptVersion).toBe('v1');
      expect(insight.model).toBe('mock');

      const content = insight.content as Record<string, unknown>;
      expect(content['kind']).toBe('conversation_summary');
      expect(content['intent']).toBe('sales');
      expect(typeof content['summary']).toBe('string');

      const citations = insight.citations as string[];
      expect(Array.isArray(citations)).toBe(true);
      expect(citations.length).toBeGreaterThan(0);

      for (const id of citations) {
        const event = await db.timelineEvent.findFirst({ where: { id } });
        expect(event, `citation ${id} must be a real TimelineEvent`).not.toBeNull();
        expect(event!.workspaceId).toBe(f.workspaceId);
        // …and it must belong to this conversation's thread, not just to the workspace.
        expect(f.threadEventIds).toContain(event!.id);
        expect((event!.payload as Record<string, unknown>)['conversationExternalId']).toBe(
          f.conversationExternalId,
        );
      }
    });
  });

  it('drops a hallucinated citation rather than storing it', async () => {
    const model = mockAiModel({
      complete: () => ({
        text: JSON.stringify({
          summary: 'made up',
          intent: 'support',
          sentiment: 'neutral',
          urgency: 'low',
          nextAction: 'nothing',
          confidence: 0.9,
          citations: [
            'deadbeef-dead-4ead-8ead-deadbeefdead',
            f.threadEventIds[0],
            f.otherThreadEventId, // real row, but a different thread: not in this prompt's context
          ],
        }),
      }),
    });
    const result = await f.db.runtime.withTenant(f.actor, (db) =>
      summarizeConversation(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      }),
    );
    expect(result.citations).toEqual([f.threadEventIds[0]]);
  });

  it('records usage on the ledger', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
      await summarizeConversation(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      });
      const rows = await db.aiUsage.findMany({ where: { workspaceId: f.workspaceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.feature).toBe('summary');
      expect(rows[0]!.promptTokens).toBeGreaterThan(0);
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
    });
  });

  it('kill switch: refuses without ever calling the model', async () => {
    const model = mockAiModel();
    const before = await f.db.runtime.withTenant(f.actor, (db) =>
      db.aiInsight.count({ where: { workspaceId: f.workspaceId } }),
    );

    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        summarizeConversation(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });

    expect(model.calls.complete).toBe(0);
    expect(model.calls.embed).toBe(0);
    const after = await f.db.runtime.withTenant(f.actor, (db) =>
      db.aiInsight.count({ where: { workspaceId: f.workspaceId } }),
    );
    expect(after).toBe(before);
  });

  it('redacts PII before it reaches the prompt', async () => {
    let seenUser = '';
    const model = mockAiModel({
      complete: (input) => {
        seenUser = input.user;
        return {
          text: JSON.stringify({
            summary: 's',
            intent: 'sales',
            sentiment: 'neutral',
            urgency: 'low',
            nextAction: 'n',
            confidence: 0.5,
            citations: [],
          }),
        };
      },
    });
    await f.db.runtime.withTenant(f.actor, (db) =>
      summarizeConversation(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      }),
    );
    expect(seenUser).not.toContain('ada@example.com');
    expect(seenUser).toContain('[REDACTED_EMAIL]');
    expect(seenUser).not.toContain('7946 0958');
    // The ids themselves must survive redaction, or citations could never be verified.
    for (const id of f.threadEventIds) expect(seenUser).toContain(`id: ${id}`);
  });

  it('is NOT_FOUND for an unknown conversation', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        summarizeConversation(deps(db, model), {
          workspaceId: f.workspaceId,
          conversationId: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(model.calls.complete).toBe(0);
  });
});

describe('generateRelationshipBrief', () => {
  it('writes a SUMMARY insight discriminated by content.kind, citing real events', async () => {
    const model = mockAiModel();
    const result = await f.db.runtime.withTenant(f.actor, (db) =>
      generateRelationshipBrief(deps(db, model), {
        workspaceId: f.workspaceId,
        recordId: f.personRecordId,
      }),
    );

    await f.db.runtime.withTenant(f.actor, async (db) => {
      const insight = await db.aiInsight.findFirstOrThrow({ where: { id: result.insightId } });
      expect(insight.kind).toBe('SUMMARY');
      expect(insight.recordId).toBe(f.personRecordId);
      expect(insight.conversationId).toBeNull();
      const content = insight.content as Record<string, unknown>;
      expect(content['kind']).toBe('relationship_brief');
      expect(content['platforms']).toEqual(['INSTAGRAM']);

      const citations = insight.citations as string[];
      expect(citations.length).toBeGreaterThan(0);
      const rows = await db.timelineEvent.findMany({ where: { id: { in: citations } } });
      expect(rows).toHaveLength(citations.length);
      for (const r of rows) expect(r.workspaceId).toBe(f.workspaceId);
    });
  });

  it('kill switch: no model call', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        generateRelationshipBrief(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.complete).toBe(0);
  });
});

describe('draftReply', () => {
  it('returns a draft without persisting an insight', async () => {
    const model = mockAiModel();
    const before = await f.db.runtime.withTenant(f.actor, (db) =>
      db.aiInsight.count({ where: { workspaceId: f.workspaceId } }),
    );
    const out = await f.db.runtime.withTenant(f.actor, (db) =>
      draftReply(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      }),
    );
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.promptVersion).toBe('v1');
    expect(out.citations.every((c) => f.threadEventIds.includes(c))).toBe(true);
    const after = await f.db.runtime.withTenant(f.actor, (db) =>
      db.aiInsight.count({ where: { workspaceId: f.workspaceId } }),
    );
    expect(after).toBe(before);
  });

  it('retries shorter when the first draft busts maxLength, and truncates if it still does', async () => {
    let attempt = 0;
    const model = mockAiModel({
      complete: () => {
        attempt += 1;
        return {
          text: JSON.stringify({
            text: attempt === 1 ? 'x'.repeat(200) : 'y'.repeat(30),
            citations: [],
          }),
        };
      },
    });
    const short = await f.db.runtime.withTenant(f.actor, (db) =>
      draftReply(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        maxLength: 40,
      }),
    );
    expect(model.calls.complete).toBe(2);
    expect(short.text).toBe('y'.repeat(30));

    const stubborn = mockAiModel({
      complete: () => ({ text: JSON.stringify({ text: 'z'.repeat(500), citations: [] }) }),
    });
    const truncated = await f.db.runtime.withTenant(f.actor, (db) =>
      draftReply(deps(db, stubborn), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        maxLength: 25,
      }),
    );
    expect(truncated.text).toHaveLength(25);
  });

  it('passes the author instructions into the prompt', async () => {
    let seen = '';
    const model = mockAiModel({
      complete: (input) => {
        seen = input.user;
        return { text: JSON.stringify({ text: 'ok', citations: [] }) };
      },
    });
    await f.db.runtime.withTenant(f.actor, (db) =>
      draftReply(deps(db, model), {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        instructions: 'offer the annual discount',
      }),
    );
    expect(seen).toContain('offer the annual discount');
  });

  it('kill switch: no model call', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        draftReply(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.complete).toBe(0);
  });
});
