/**
 * The workflow engine (spec §14, Phase 10).
 *
 * Depends on `@nexus/core` and `@nexus/db` and nothing else (ADR-021 decision 1): every
 * platform-specific side effect — sending a reply, calling a webhook, sending mail, enqueueing an
 * AI job — is a callback the caller injects on `AutomationRuntime`. `apps/worker` is the one place
 * that imports the sync engine, the mail package and this one together, so it is the one place
 * that wires them. The only surface other packages need in order to *feed* the engine is the
 * plain-data `AutomationEvent`.
 */

/** Workflow engine (spec §14). Built in Phase 10. The package exists so the layout is stable. */
export const AUTOMATION_PACKAGE = '@nexus/automation' as const;

// ── conditions ────────────────────────────────────────────────────────────────
export {
  CONDITION_OPS,
  conditionSchema,
  conditionsMatch,
  evaluateCondition,
  getByPath,
  isEmptyValue,
  parseConditions,
} from './conditions.ts';
export type { ConditionLeaf, ConditionNode, ConditionOp } from './conditions.ts';

// ── triggers, events, actions ─────────────────────────────────────────────────
export {
  TRIGGER_TYPES,
  automationEventSchema,
  parseActions,
  parseTrigger,
  triggerKeyFor,
  triggerMatches,
  workflowActionSchema,
  workflowActionsSchema,
  workflowTriggerSchema,
} from './events.ts';
export type {
  AutomationEvent,
  TargetRef,
  TriggerType,
  WorkflowAction,
  WorkflowActionType,
  WorkflowTrigger,
} from './events.ts';

// ── the injected runtime ──────────────────────────────────────────────────────
export {
  createAutomationRuntime,
  defaultCallWebhook,
  defaultSleep,
  matchingActor,
  silentLogger,
  workflowActor,
} from './runtime.ts';
export type { AutomationLogger, AutomationRuntime } from './runtime.ts';

// ── row + step shapes ─────────────────────────────────────────────────────────
export type {
  EvaluationContext,
  RunStatus,
  RunStep,
  WorkflowRow,
  WorkflowRunRow,
} from './types.ts';

// ── evaluation context ────────────────────────────────────────────────────────
export {
  buildContext,
  loadRecordContext,
  referencesRecord,
  resolveContextRecordId,
} from './context.ts';

// ── action execution (exported for callers that drive a single action) ────────
export { ActionError, executeActions, resolveRef } from './actions.ts';
export type { ActionContext } from './actions.ts';

// ── the engine ────────────────────────────────────────────────────────────────
export {
  DEFAULT_RATE_CAP_PER_HOUR,
  matchWorkflows,
  reactToEvent,
  runWorkflowForEvent,
} from './engine.ts';

// ── dry run ───────────────────────────────────────────────────────────────────
export { DRY_RUN_DEFAULT_DAYS, dryRun } from './dry-run.ts';
export type { DryRunReport, DryRunSample } from './dry-run.ts';

// ── versioning ────────────────────────────────────────────────────────────────
export { listWorkflowVersions, rollbackWorkflow, snapshotWorkflowVersion } from './versions.ts';
