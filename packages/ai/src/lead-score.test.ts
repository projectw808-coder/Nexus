/**
 * §13.5: the score is additive and transparent — the factor list adds up to the number, and the
 * relative ordering follows the signals.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_WEIGHTS, scoreLead, type LeadSignals } from './lead-score.ts';

const cold: LeadSignals = {
  lastTouchDaysAgo: 90,
  touchCountLast30d: 0,
  distinctPlatforms: 1,
  pipelineStage: 'lead',
  hasVerifiedEmail: false,
};
const warm: LeadSignals = {
  lastTouchDaysAgo: 10,
  touchCountLast30d: 6,
  distinctPlatforms: 2,
  pipelineStage: 'qualified',
  hasVerifiedEmail: true,
};
const hot: LeadSignals = {
  lastTouchDaysAgo: 1,
  touchCountLast30d: 22,
  distinctPlatforms: 4,
  pipelineStage: 'negotiation',
  hasVerifiedEmail: true,
};

describe('scoreLead', () => {
  it('orders cold < warm < hot', () => {
    const c = scoreLead({ signals: cold }).score;
    const w = scoreLead({ signals: warm }).score;
    const h = scoreLead({ signals: hot }).score;
    expect(c).toBeLessThan(w);
    expect(w).toBeLessThan(h);
  });

  it('rewards more recent and more frequent touches, all else equal', () => {
    const base = { ...warm, lastTouchDaysAgo: 20, touchCountLast30d: 2 };
    const better = { ...warm, lastTouchDaysAgo: 2, touchCountLast30d: 12 };
    expect(scoreLead({ signals: better }).score).toBeGreaterThan(
      scoreLead({ signals: base }).score,
    );
  });

  it('is additive: the factors sum to the score', () => {
    for (const signals of [cold, warm, hot]) {
      const out = scoreLead({ signals });
      const sum = out.factors.reduce((n, f) => n + f.contribution, 0);
      expect(Math.round(sum)).toBe(out.score);
    }
  });

  it('exposes every factor with its weight, value and contribution', () => {
    const out = scoreLead({ signals: hot });
    expect(out.factors.map((f) => f.label)).toEqual([
      'Recent engagement',
      'Touches in the last 30 days',
      'Channels engaged',
      'Pipeline stage',
      'Verified email',
    ]);
    for (const f of out.factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(1);
      expect(f.contribution).toBeCloseTo(f.weight * f.value, 1);
    }
    expect(out.factors.reduce((n, f) => n + f.weight, 0)).toBe(
      Object.values(DEFAULT_LEAD_WEIGHTS).reduce((n, v) => n + v, 0),
    );
  });

  it('honours per-workspace weight overrides', () => {
    const signals = { ...cold, hasVerifiedEmail: true };
    const withDefault = scoreLead({ signals });
    const emailHeavy = scoreLead({ signals, weights: { verifiedEmail: 60 } });
    expect(emailHeavy.score).toBeGreaterThan(withDefault.score);
    expect(emailHeavy.factors.find((f) => f.label === 'Verified email')?.contribution).toBe(60);
  });

  it('scores a never-touched lead at the floor and clamps to 0-100', () => {
    const never = scoreLead({
      signals: {
        lastTouchDaysAgo: null,
        touchCountLast30d: 0,
        distinctPlatforms: 0,
        pipelineStage: null,
        hasVerifiedEmail: false,
      },
    });
    expect(never.score).toBe(0);
    const maxed = scoreLead({ signals: hot, weights: { recency: 500 } });
    expect(maxed.score).toBe(100);
  });
});
