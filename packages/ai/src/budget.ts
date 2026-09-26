/**
 * The kill switch, the per-feature switches and the monthly token budget (spec §13, ADR-021
 * decision 4). `workspace.settings.ai` is this package's namespace in the existing settings bag —
 * the same shape `settings.inbox` established in Phase 7.
 *
 * Every feature function calls `checkAiAllowed()` before it touches the model, and the kill-switch
 * branch answers without a query, so flipping the switch stops the very next call in the same
 * request.
 */
import { NexusError } from '@nexus/core';
import type { TenantDb } from '@nexus/db';
import type { PiiRedactionLevel } from './redact.ts';

export type AiFeature = 'summary' | 'relationship_brief' | 'research' | 'reply_draft' | 'embedding';

export const AI_FEATURES: readonly AiFeature[] = [
  'summary',
  'relationship_brief',
  'research',
  'reply_draft',
  'embedding',
];

export type AiSettings = {
  killSwitch: boolean;
  monthlyTokenBudget?: number;
  /** Already resolved against the env fallback. */
  piiRedaction: PiiRedactionLevel;
  leadScoreWeights?: Record<string, number>;
  /** Default-true per feature unless explicitly false. */
  features: Partial<Record<AiFeature, boolean>>;
};

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function weightsOf(v: unknown): Record<string, number> | undefined {
  if (!isDict(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[k] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function featuresOf(v: unknown): Partial<Record<AiFeature, boolean>> {
  if (!isDict(v)) return {};
  const out: Partial<Record<AiFeature, boolean>> = {};
  for (const f of AI_FEATURES) {
    const raw = v[f];
    if (typeof raw === 'boolean') out[f] = raw;
  }
  return out;
}

function redactionOf(v: unknown, fallback: PiiRedactionLevel): PiiRedactionLevel {
  return v === 'strict' || v === 'standard' || v === 'off' ? v : fallback;
}

/** Read `workspace.settings.ai`, applying env fallbacks. Tolerant of anything in the JSON bag. */
export function aiSettingsFrom(
  workspaceSettingsJson: unknown,
  envDefaultPiiRedaction: PiiRedactionLevel,
): AiSettings {
  const ai = isDict(workspaceSettingsJson) ? workspaceSettingsJson['ai'] : undefined;
  const bag = isDict(ai) ? ai : {};
  const budget = numberOrUndefined(bag['monthlyTokenBudget']);
  const weights = weightsOf(bag['leadScoreWeights']);
  return {
    killSwitch: bag['killSwitch'] === true,
    ...(budget === undefined ? {} : { monthlyTokenBudget: budget }),
    piiRedaction: redactionOf(bag['piiRedaction'], envDefaultPiiRedaction),
    ...(weights === undefined ? {} : { leadScoreWeights: weights }),
    features: featuresOf(bag['features']),
  };
}

/** Convenience for callers that only have the workspace id to hand. */
export async function loadAiSettings(
  db: TenantDb,
  workspaceId: string,
  envDefaultPiiRedaction: PiiRedactionLevel,
): Promise<AiSettings> {
  const ws = await db.workspace.findFirst({
    where: { id: workspaceId },
    select: { settings: true },
  });
  return aiSettingsFrom(ws?.settings ?? {}, envDefaultPiiRedaction);
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type AiAllowance = { allowed: boolean; reason?: string };

export async function checkAiAllowed(
  db: TenantDb,
  workspaceId: string,
  feature: AiFeature,
  settings: AiSettings,
  opts: { now?: Date } = {},
): Promise<AiAllowance> {
  // No query: the switch is authoritative on its own, so nothing can race past it.
  if (settings.killSwitch) return { allowed: false, reason: 'kill switch is on' };
  if (settings.features[feature] === false) return { allowed: false, reason: 'feature disabled' };
  const budget = settings.monthlyTokenBudget;
  if (budget === undefined) return { allowed: true };

  const since = startOfUtcMonth(opts.now ?? new Date());
  const agg = await db.aiUsage.aggregate({
    where: { workspaceId, createdAt: { gte: since } },
    _sum: { promptTokens: true, completionTokens: true },
  });
  const used = (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0);
  if (used >= budget) return { allowed: false, reason: 'monthly token budget exceeded' };
  return { allowed: true };
}

/** Throw the allowance as a `POLICY_BLOCKED` failure — what every feature function does. */
export function assertAllowed(allowance: AiAllowance, feature: AiFeature): void {
  if (allowance.allowed) return;
  throw new NexusError('POLICY_BLOCKED', {
    message: `AI feature "${feature}" is not available: ${allowance.reason ?? 'blocked'}`,
    context: { reason: allowance.reason ?? 'blocked', capability: feature },
    details: { feature, reason: allowance.reason ?? 'blocked' },
  });
}

/** Append-only cost ledger row. `costCents` is plumbed through; pricing tables are out of scope. */
export async function recordAiUsage(
  db: TenantDb,
  input: {
    workspaceId: string;
    feature: AiFeature;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costCents?: number;
  },
): Promise<void> {
  await db.aiUsage.create({
    data: {
      workspaceId: input.workspaceId,
      feature: input.feature,
      model: input.model,
      promptTokens: Math.max(0, Math.round(input.promptTokens)),
      completionTokens: Math.max(0, Math.round(input.completionTokens)),
      costCents: Math.max(0, Math.round(input.costCents ?? 0)),
    },
  });
}
