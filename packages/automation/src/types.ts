/**
 * Structural row shapes the engine reads and writes. Deliberately structural rather than the
 * Prisma model types: the JSON columns are `unknown` here (they are parsed through the Zod
 * schemas in `events.ts` / `conditions.ts` before use), and a caller can hand the engine a row it
 * assembled itself without importing Prisma's generated types.
 */
import type { RunStatus } from '@nexus/db';

export type { RunStatus };

export type WorkflowRow = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  /** `WorkflowTrigger`-shaped. Parse with `parseTrigger`. */
  trigger: unknown;
  /** `ConditionNode`-shaped, or `[]` / `{}` for "no conditions". Parse with `parseConditions`. */
  conditions: unknown;
  /** `WorkflowAction[]`-shaped. Parse with `parseActions`. */
  actions: unknown;
  version: number;
  /** Per-action scratch pad keyed by the action's own `id` (ADR-021) — e.g. the round-robin cursor. */
  state: unknown;
};

/** One entry in `WorkflowRun.steps`: what the engine did, in order, with inputs and outputs. */
export type RunStep = {
  actionId: string;
  type: string;
  /** ISO-8601. */
  at: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type WorkflowRunRow = {
  id: string;
  workspaceId: string;
  workflowId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  context: unknown;
  steps: unknown;
  error: string | null;
  triggerKey: string | null;
};

/** The object conditions are evaluated against: `{ event, record? }`. */
export type EvaluationContext = Record<string, unknown> & {
  event: unknown;
  record?: Record<string, unknown> | null;
};
