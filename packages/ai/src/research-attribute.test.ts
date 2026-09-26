/**
 * §13.3: the privileged AI_RESEARCH writer (the one path allowed to write a COMPUTED_TYPES
 * attribute) and the feature function that drives it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateRecordValues } from '@nexus/core';
import type { TenantDb } from '@nexus/db';
import type { AiSettings } from './budget.ts';
import type { AiDeps } from './context.ts';
import { mockAiModel, type MockAiModel } from './model.ts';
import { runResearchAttribute, writeAiResearchValue } from './research-attribute.ts';
import { createFixture, fixedClock, settings, type Fixture } from './testing/fixtures.ts';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture('research');
}, 120_000);
afterAll(async () => {
  await f.close();
});

function deps(db: TenantDb, model: MockAiModel, s: AiSettings = settings()): AiDeps {
  return { db, model, now: fixedClock, settings: s };
}

describe('the normal write path still refuses AI_RESEARCH', () => {
  it('validateRecordValues rejects it as computed — which is why this package needs its own writer', () => {
    const r = validateRecordValues(
      [
        {
          id: f.researchAttributeId,
          apiSlug: 'employer',
          title: 'Employer',
          type: 'AI_RESEARCH',
          config: { prompt: 'q', outputType: 'TEXT' },
          isRequired: false,
          isUnique: false,
          isSystem: false,
        },
      ],
      { employer: { value: 'Acme', sources: [], asOf: new Date().toISOString() } },
      'update',
    );
    expect(r.ok).toBe(false);
  });
});

describe('writeAiResearchValue', () => {
  it('merges into values, emits a FIELD_CHANGE event and writes an audit row', async () => {
    const value = {
      value: 'Analytical Engines Ltd',
      sources: [{ url: 'https://example.com/ada', title: 'Ada' }],
      asOf: '2026-09-25T12:00:00.000Z',
      confidence: 0.8,
    };
    await f.db.runtime.withTenant(f.actor, async (db) => {
      const out = await writeAiResearchValue(db, {
        workspaceId: f.workspaceId,
        recordId: f.personRecordId,
        attributeId: f.researchAttributeId,
        value,
        now: new Date(value.asOf),
      });
      expect(out.before).toBeNull();
      expect(out.after.value).toBe('Analytical Engines Ltd');

      const record = await db.record.findFirstOrThrow({ where: { id: f.personRecordId } });
      const values = record.values as Record<string, unknown>;
      // The pre-existing name value must survive the read-modify-write.
      expect(values[f.nameAttributeId]).toBe('Ada Lovelace');
      expect(values[f.researchAttributeId]).toMatchObject({ value: 'Analytical Engines Ltd' });

      const event = await db.timelineEvent.findFirstOrThrow({
        where: { recordId: f.personRecordId, type: 'FIELD_CHANGE' },
        orderBy: { occurredAt: 'desc' },
      });
      const payload = event.payload as Record<string, unknown>;
      expect(payload['attributeId']).toBe(f.researchAttributeId);
      expect(payload['source']).toBe('ai_research');

      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: 'record.ai_research_updated', targetId: f.personRecordId },
        orderBy: { at: 'desc' },
      });
      expect(audit.actorType).toBe('SYSTEM');
      expect(audit.actorUserId).toBeNull();
      expect(audit.targetType).toBe('Record');
    });
  });

  it('rejects a value that does not match aiResearchValueSchema', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await expect(
        writeAiResearchValue(db, {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
          attributeId: f.researchAttributeId,
          value: { value: 'x', sources: [{ url: 'not-a-url' }], asOf: 'yesterday' },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  it('refuses to write a non-AI_RESEARCH attribute', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await expect(
        writeAiResearchValue(db, {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
          attributeId: f.nameAttributeId,
          value: { value: 'x', sources: [], asOf: new Date().toISOString() },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });
});

describe('runResearchAttribute', () => {
  it('writes the typed value and a RESEARCH insight with sources in content', async () => {
    const model = mockAiModel();
    const result = await f.db.runtime.withTenant(f.actor, (db) =>
      runResearchAttribute(deps(db, model), {
        workspaceId: f.workspaceId,
        recordId: f.personRecordId,
        attributeId: f.researchAttributeId,
        attributeConfig: { prompt: 'Who does this person work for?', outputType: 'TEXT' },
      }),
    );

    await f.db.runtime.withTenant(f.actor, async (db) => {
      const insight = await db.aiInsight.findFirstOrThrow({ where: { id: result.insightId } });
      expect(insight.kind).toBe('RESEARCH');
      const content = insight.content as Record<string, unknown>;
      expect(content['value']).toBe('Acme Industries');
      expect(content['sources']).toEqual([
        { url: 'https://example.com/acme', title: 'Acme Industries' },
      ]);
      expect(content['asOf']).toBe(fixedClock().toISOString());

      // citations stay TimelineEvent ids — never source urls.
      const citations = insight.citations as string[];
      for (const id of citations) {
        const row = await db.timelineEvent.findFirst({ where: { id } });
        expect(row, `citation ${id} must be a real TimelineEvent`).not.toBeNull();
      }

      const record = await db.record.findFirstOrThrow({ where: { id: f.personRecordId } });
      const stored = (record.values as Record<string, unknown>)[f.researchAttributeId];
      expect(stored).toMatchObject({ value: 'Acme Industries', confidence: 0.55 });
    });
  });

  it('enforces the declared outputType (SELECT must be an allowed option id)', async () => {
    const options = [
      { id: 'opt_a', label: 'Enterprise' },
      { id: 'opt_b', label: 'SMB' },
    ];
    const bad = mockAiModel({
      complete: () => ({
        text: JSON.stringify({ value: 'Enterprise', sources: [], citations: [] }),
      }),
    });
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        runResearchAttribute(deps(db, bad), {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
          attributeId: f.researchAttributeId,
          attributeConfig: { prompt: 'Segment?', outputType: 'SELECT', options },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(bad.calls.complete).toBe(2); // one corrective retry, then a hard stop

    const good = mockAiModel({
      complete: () => ({ text: JSON.stringify({ value: 'opt_b', sources: [], citations: [] }) }),
    });
    const out = await f.db.runtime.withTenant(f.actor, (db) =>
      runResearchAttribute(deps(db, good), {
        workspaceId: f.workspaceId,
        recordId: f.personRecordId,
        attributeId: f.researchAttributeId,
        attributeConfig: { prompt: 'Segment?', outputType: 'SELECT', options },
      }),
    );
    expect((out.content as Record<string, unknown>)['value']).toBe('opt_b');
  });

  it('accepts a null answer when the evidence does not support one', async () => {
    const model = mockAiModel({
      complete: () => ({ text: JSON.stringify({ value: null, sources: [], citations: [] }) }),
    });
    await f.db.runtime.withTenant(f.actor, async (db) => {
      const out = await runResearchAttribute(deps(db, model), {
        workspaceId: f.workspaceId,
        recordId: f.personRecordId,
        attributeId: f.researchAttributeId,
        attributeConfig: { prompt: 'Revenue?', outputType: 'NUMBER' },
      });
      expect((out.content as Record<string, unknown>)['value']).toBeNull();
    });
  });

  it('kill switch: no model call and no value written', async () => {
    const model = mockAiModel();
    const before = await f.db.runtime.withTenant(f.actor, async (db) => {
      const r = await db.record.findFirstOrThrow({ where: { id: f.personRecordId } });
      return JSON.stringify(r.values);
    });
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        runResearchAttribute(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
          attributeId: f.researchAttributeId,
          attributeConfig: { prompt: 'q', outputType: 'TEXT' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.complete).toBe(0);
    const after = await f.db.runtime.withTenant(f.actor, async (db) => {
      const r = await db.record.findFirstOrThrow({ where: { id: f.personRecordId } });
      return JSON.stringify(r.values);
    });
    expect(after).toBe(before);
  });

  it('feature switch: research off blocks only research', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        runResearchAttribute(deps(db, model, settings({ features: { research: false } })), {
          workspaceId: f.workspaceId,
          recordId: f.personRecordId,
          attributeId: f.researchAttributeId,
          attributeConfig: { prompt: 'q', outputType: 'TEXT' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.complete).toBe(0);
  });
});
