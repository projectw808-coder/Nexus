/**
 * The kill switch, the per-feature switches and the monthly token budget, against a real
 * database. `aiSettingsFrom` is pure and covered alongside.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aiSettingsFrom,
  assertAllowed,
  checkAiAllowed,
  loadAiSettings,
  recordAiUsage,
  startOfUtcMonth,
} from './budget.ts';
import { createFixture, settings, type Fixture } from './testing/fixtures.ts';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture('budget');
}, 120_000);
afterAll(async () => {
  await f.close();
});

describe('aiSettingsFrom', () => {
  it('defaults everything sanely when the namespace is absent', () => {
    const s = aiSettingsFrom({}, 'standard');
    expect(s).toEqual({ killSwitch: false, piiRedaction: 'standard', features: {} });
    expect(aiSettingsFrom(null, 'off').piiRedaction).toBe('off');
    expect(aiSettingsFrom({ inbox: { slaTargetMinutes: 30 } }, 'strict').killSwitch).toBe(false);
  });

  it('reads the ai namespace and lets the workspace override the env redaction level', () => {
    const s = aiSettingsFrom(
      {
        inbox: { slaTargetMinutes: 30 },
        ai: {
          killSwitch: true,
          monthlyTokenBudget: 5000,
          piiRedaction: 'off',
          leadScoreWeights: { recency: 50, bogus: 'x' },
          features: { summary: false, research: true, nonsense: true },
        },
      },
      'strict',
    );
    expect(s.killSwitch).toBe(true);
    expect(s.monthlyTokenBudget).toBe(5000);
    expect(s.piiRedaction).toBe('off');
    expect(s.leadScoreWeights).toEqual({ recency: 50 });
    expect(s.features).toEqual({ summary: false, research: true });
  });

  it('ignores junk in the bag', () => {
    const s = aiSettingsFrom({ ai: { monthlyTokenBudget: -1, piiRedaction: 'loud' } }, 'standard');
    expect(s.monthlyTokenBudget).toBeUndefined();
    expect(s.piiRedaction).toBe('standard');
  });
});

describe('startOfUtcMonth', () => {
  it('is the 1st at midnight UTC', () => {
    expect(startOfUtcMonth(new Date('2026-09-25T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
});

describe('loadAiSettings', () => {
  it('reads workspace.settings.ai', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.workspace.update({
        where: { id: f.workspaceId },
        data: { settings: { ai: { piiRedaction: 'off' } } },
      });
      const s = await loadAiSettings(db, f.workspaceId, 'strict');
      expect(s.piiRedaction).toBe('off');
      await db.workspace.update({ where: { id: f.workspaceId }, data: { settings: {} } });
    });
  });
});

describe('checkAiAllowed', () => {
  it('allows by default', async () => {
    const r = await f.db.runtime.withTenant(f.actor, (db) =>
      checkAiAllowed(db, f.workspaceId, 'summary', settings()),
    );
    expect(r).toEqual({ allowed: true });
  });

  it('refuses when the kill switch is on', async () => {
    const r = await f.db.runtime.withTenant(f.actor, (db) =>
      checkAiAllowed(db, f.workspaceId, 'summary', settings({ killSwitch: true })),
    );
    expect(r).toEqual({ allowed: false, reason: 'kill switch is on' });
  });

  it('refuses a feature that is explicitly disabled, and only that feature', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      const s = settings({ features: { research: false } });
      expect(await checkAiAllowed(db, f.workspaceId, 'research', s)).toEqual({
        allowed: false,
        reason: 'feature disabled',
      });
      expect(await checkAiAllowed(db, f.workspaceId, 'summary', s)).toEqual({ allowed: true });
    });
  });

  it('allows below and refuses at or above the monthly budget', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
      await recordAiUsage(db, {
        workspaceId: f.workspaceId,
        feature: 'summary',
        model: 'mock',
        promptTokens: 400,
        completionTokens: 100,
      });
      const now = new Date();
      expect(
        await checkAiAllowed(db, f.workspaceId, 'summary', settings({ monthlyTokenBudget: 1000 }), {
          now,
        }),
      ).toEqual({ allowed: true });
      expect(
        await checkAiAllowed(db, f.workspaceId, 'summary', settings({ monthlyTokenBudget: 500 }), {
          now,
        }),
      ).toEqual({ allowed: false, reason: 'monthly token budget exceeded' });
    });
  });

  it('ignores usage from a previous calendar month', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
      const lastMonth = new Date(startOfUtcMonth(new Date()).getTime() - 86_400_000);
      await db.aiUsage.create({
        data: {
          workspaceId: f.workspaceId,
          feature: 'summary',
          model: 'mock',
          promptTokens: 10_000,
          completionTokens: 0,
          costCents: 0,
          createdAt: lastMonth,
        },
      });
      expect(
        await checkAiAllowed(db, f.workspaceId, 'summary', settings({ monthlyTokenBudget: 100 })),
      ).toEqual({ allowed: true });
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
    });
  });
});

describe('recordAiUsage', () => {
  it('appends a ledger row, defaulting costCents to 0', async () => {
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
      await recordAiUsage(db, {
        workspaceId: f.workspaceId,
        feature: 'embedding',
        model: 'mock',
        promptTokens: 7,
        completionTokens: 0,
      });
      const rows = await db.aiUsage.findMany({ where: { workspaceId: f.workspaceId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ feature: 'embedding', promptTokens: 7, costCents: 0 });
      await db.aiUsage.deleteMany({ where: { workspaceId: f.workspaceId } });
    });
  });
});

describe('assertAllowed', () => {
  it('throws POLICY_BLOCKED carrying the reason', () => {
    expect(() => assertAllowed({ allowed: false, reason: 'kill switch is on' }, 'summary')).toThrow(
      /kill switch is on/,
    );
    expect(() => assertAllowed({ allowed: true }, 'summary')).not.toThrow();
  });
});
