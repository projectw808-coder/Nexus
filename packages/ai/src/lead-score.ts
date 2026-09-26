/**
 * §13.5 transparent lead scoring. Deliberately not a model call: no tokens, no cost, no kill
 * switch (ADR-021 — "lead scoring makes no model call"). Pure arithmetic over signals the caller
 * already has, so the UI can show every contributing factor and a workspace can retune the
 * weights in `settings.ai.leadScoreWeights`.
 *
 * The model is additive: `contribution = weight × value`, `score = round(Σ contribution)` clamped
 * to 0–100. That is what makes it explainable — the factor list literally adds up to the number.
 */

export type LeadSignals = {
  /** Days since the last touch on any channel; null when there has never been one. */
  lastTouchDaysAgo: number | null;
  touchCountLast30d: number;
  distinctPlatforms: number;
  pipelineStage: string | null;
  hasVerifiedEmail: boolean;
};

export type LeadFactor = {
  label: string;
  /** Points this factor can contribute at full strength. */
  weight: number;
  /** Normalised signal strength, 0–1. */
  value: number;
  /** `weight × value`. */
  contribution: number;
};

export type LeadScore = { score: number; factors: LeadFactor[] };

/** Points available per factor; they sum to 100. Override per workspace. */
export const DEFAULT_LEAD_WEIGHTS: Record<string, number> = {
  recency: 30,
  frequency: 25,
  breadth: 15,
  pipeline: 20,
  verifiedEmail: 10,
};

/** Half-life style decay: today 1.0, a week ago ~0.75, a month ago ~0.25, a quarter ~0. */
export function recencyValue(daysAgo: number | null): number {
  if (daysAgo === null || !Number.isFinite(daysAgo)) return 0;
  const d = Math.max(0, daysAgo);
  return clamp01(1 - d / 40);
}

/** Saturating: 20+ touches in 30 days is full marks. */
export function frequencyValue(count: number): number {
  return clamp01((Number.isFinite(count) ? Math.max(0, count) : 0) / 20);
}

/** Three or more channels is full marks (§13.5 "depth per platform"). */
export function breadthValue(platforms: number): number {
  return clamp01((Number.isFinite(platforms) ? Math.max(0, platforms) : 0) / 3);
}

/** The system Deal stages (§6), lower-cased; anything unknown sits at the midpoint of "early". */
const STAGE_VALUES: Record<string, number> = {
  lead: 0.2,
  qualified: 0.45,
  proposal: 0.7,
  negotiation: 0.85,
  won: 1,
  lost: 0,
};

export function pipelineValue(stage: string | null): number {
  if (!stage) return 0;
  return STAGE_VALUES[stage.trim().toLowerCase()] ?? 0.3;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function scoreLead(input: {
  signals: LeadSignals;
  weights?: Record<string, number>;
}): LeadScore {
  const w = { ...DEFAULT_LEAD_WEIGHTS, ...(input.weights ?? {}) };
  const s = input.signals;

  const spec: { key: string; label: string; value: number }[] = [
    { key: 'recency', label: 'Recent engagement', value: recencyValue(s.lastTouchDaysAgo) },
    {
      key: 'frequency',
      label: 'Touches in the last 30 days',
      value: frequencyValue(s.touchCountLast30d),
    },
    { key: 'breadth', label: 'Channels engaged', value: breadthValue(s.distinctPlatforms) },
    { key: 'pipeline', label: 'Pipeline stage', value: pipelineValue(s.pipelineStage) },
    { key: 'verifiedEmail', label: 'Verified email', value: s.hasVerifiedEmail ? 1 : 0 },
  ];

  const factors: LeadFactor[] = spec.map((f) => {
    const weight = Number.isFinite(w[f.key]) ? (w[f.key] as number) : 0;
    // Round the displayed value first, then derive the contribution from it, so the breakdown a
    // user reads is arithmetically self-consistent: weight × value really is the contribution.
    const value = round2(f.value);
    return { label: f.label, weight, value, contribution: round2(weight * value) };
  });

  const total = factors.reduce((n, f) => n + f.contribution, 0);
  return { score: Math.min(100, Math.max(0, Math.round(total))), factors };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
