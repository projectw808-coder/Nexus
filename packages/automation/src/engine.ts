/**
 * The engine: match an event to workflows, then run each one with every §14 safety rail on —
 * idempotency, loop detection, a per-workflow rate cap, and a step-by-step run history that
 * survives a partial failure.
 */
import { ZodError } from 'zod';
import type { Prisma, TenantDb } from '@nexus/db';
import { executeActions, type ActionContext } from './actions.ts';
import { conditionsMatch } from './conditions.ts';
import { buildContext } from './context.ts';
import {
  automationEventSchema,
  parseActions,
  parseTrigger,
  triggerKeyFor,
  triggerMatches,
  type AutomationEvent,
} from './events.ts';
import { matchingActor, workflowActor, type AutomationRuntime } from './runtime.ts';
import type { RunStep, RunStatus, WorkflowRow, WorkflowRunRow } from './types.ts';

/** The per-workflow ceiling when the caller does not override it (§14 "per-workflow rate caps"). */
export const DEFAULT_RATE_CAP_PER_HOUR = 100;

const RUN_SELECT = {
  id: true,
  workspaceId: true,
  workflowId: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  context: true,
  steps: true,
  error: true,
  triggerKey: true,
} as const;

const WORKFLOW_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  enabled: true,
  trigger: true,
  conditions: true,
  actions: true,
  version: true,
  state: true,
} as const;

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';

/**
 * Enabled workflows whose trigger matches this event's type, plus whatever narrowing the trigger
 * specifies (platform, object type, list). A workflow whose `trigger` JSON does not parse is
 * skipped rather than blowing up the whole dispatch — one bad definition must not stop the queue.
 */
export async function matchWorkflows(
  db: TenantDb,
  workspaceId: string,
  event: AutomationEvent,
): Promise<WorkflowRow[]> {
  const rows = await db.workflow.findMany({
    where: { workspaceId, enabled: true, deletedAt: null },
    select: WORKFLOW_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((row) => {
    try {
      return triggerMatches(parseTrigger(row.trigger), event);
    } catch {
      return false;
    }
  });
}

async function finalize(
  rt: AutomationRuntime,
  run: WorkflowRunRow,
  patch: { status: RunStatus; steps?: RunStep[]; error?: string | null; context?: unknown },
): Promise<WorkflowRunRow> {
  const actor = matchingActor(run.workspaceId);
  return rt.runtime.withTenant(actor, (db) =>
    db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: patch.status,
        finishedAt: rt.now(),
        error: patch.error ?? null,
        ...(patch.steps === undefined ? {} : { steps: asJson(patch.steps) }),
        ...(patch.context === undefined ? {} : { context: asJson(patch.context) }),
      },
      select: RUN_SELECT,
    }),
  );
}

/**
 * Run one workflow against one event.
 *
 * The `WorkflowRun` row is created *first*, with `triggerKey` set, so the `(workflowId,
 * triggerKey)` unique index is the idempotency check — a redelivered or replayed event loses the
 * insert race and returns the run that already happened, with no lookup-then-insert window.
 * Everything after that (loop check, rate cap, conditions, actions) reports through that row.
 */
export async function runWorkflowForEvent(
  rt: AutomationRuntime,
  workflow: WorkflowRow,
  event: AutomationEvent,
  opts?: { rateCapPerHour?: number },
): Promise<WorkflowRunRow> {
  const actor = workflowActor(workflow);
  const triggerKey = triggerKeyFor(event);
  const cap = opts?.rateCapPerHour ?? DEFAULT_RATE_CAP_PER_HOUR;

  // ── 1. idempotent create ────────────────────────────────────────────────────
  let run: WorkflowRunRow;
  try {
    run = await rt.runtime.withTenant(actor, (db) =>
      db.workflowRun.create({
        data: {
          workspaceId: workflow.workspaceId,
          workflowId: workflow.id,
          status: 'RUNNING',
          startedAt: rt.now(),
          triggerKey,
          context: asJson({ event }),
          steps: asJson([]),
        },
        select: RUN_SELECT,
      }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await rt.runtime.withTenant(actor, (db) =>
      db.workflowRun.findFirst({
        where: { workflowId: workflow.id, triggerKey },
        select: RUN_SELECT,
      }),
    );
    if (!existing) throw error;
    rt.logger.info('automation run skipped: already ran for this event', {
      workflowId: workflow.id,
      runId: existing.id,
      triggerKey,
    });
    return existing;
  }

  // ── 2. loop detection (ADR-021 decision 3) ──────────────────────────────────
  const chain = event.causation.workflowIds;
  if (chain.includes(workflow.id)) {
    rt.logger.warn('automation run halted: loop detected', {
      workflowId: workflow.id,
      chain,
    });
    return finalize(rt, run, { status: 'CANCELLED', error: 'loop_detected', steps: [] });
  }
  if (chain.length > 10) {
    return finalize(rt, run, {
      status: 'CANCELLED',
      error: 'loop_detected: chain too deep',
      steps: [],
    });
  }

  // ── 3. per-workflow rate cap ────────────────────────────────────────────────
  const since = new Date(rt.now().getTime() - 3_600_000);
  const recent = await rt.runtime.withTenant(actor, (db) =>
    db.workflowRun.count({
      where: { workflowId: workflow.id, startedAt: { gte: since }, id: { not: run.id } },
    }),
  );
  if (recent >= cap) {
    rt.logger.warn('automation run halted: rate cap', { workflowId: workflow.id, recent, cap });
    return finalize(rt, run, {
      status: 'CANCELLED',
      error: `rate_capped: ${recent} runs in the last hour (cap ${cap})`,
      steps: [],
    });
  }

  // ── 4. conditions ───────────────────────────────────────────────────────────
  let actions;
  let evaluation;
  try {
    actions = parseActions(workflow.actions);
    evaluation = await rt.runtime.withTenant(actor, (db) =>
      buildContext(db, event, workflow.conditions),
    );
    if (!conditionsMatch(workflow.conditions, evaluation)) {
      return finalize(rt, run, {
        status: 'SUCCEEDED',
        steps: [],
        context: { event, conditionsMatched: false },
      });
    }
  } catch (error) {
    const message =
      error instanceof ZodError
        ? `invalid workflow definition: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finalize(rt, run, { status: 'FAILED', error: message, steps: [] });
  }

  // ── 5. actions ──────────────────────────────────────────────────────────────
  const steps: RunStep[] = [];
  const ctx: ActionContext = {
    rt,
    workflow,
    actor,
    event,
    evaluation,
    depth: 0,
    runChild: (child, childEvent) => runWorkflowForEvent(rt, child, childEvent, opts),
  };

  let fatal: string | null = null;
  try {
    await executeActions(ctx, actions, steps);
  } catch (error) {
    // executeActions swallows per-action failures; anything escaping is infrastructural.
    fatal = error instanceof Error ? error.message : String(error);
    rt.logger.error('automation run crashed', { workflowId: workflow.id, error: fatal });
  }

  const failedSteps = steps.filter((s) => !s.ok);
  const status: RunStatus = fatal !== null || failedSteps.length > 0 ? 'FAILED' : 'SUCCEEDED';
  const error =
    fatal ??
    (failedSteps.length > 0
      ? `${failedSteps.length} of ${steps.length} step(s) failed: ${failedSteps[0]?.error ?? ''}`
      : null);

  const finished = await finalize(rt, run, {
    status,
    steps,
    error,
    context: { event, conditionsMatched: true },
  });

  await rt.runtime.withTenant(actor, (db) =>
    db.workflow.update({ where: { id: workflow.id }, data: { lastRunAt: rt.now() } }),
  );
  return finished;
}

/**
 * The top-level entry point the `automate` queue processor calls: validate the envelope, find the
 * workflows that care, run each one.
 */
export async function reactToEvent(
  rt: AutomationRuntime,
  rawEvent: AutomationEvent,
): Promise<{ matched: number; runs: string[] }> {
  const event = automationEventSchema.parse(rawEvent);
  const workflows = await rt.runtime.withTenant(matchingActor(event.workspaceId), (db) =>
    matchWorkflows(db, event.workspaceId, event),
  );

  const runs: string[] = [];
  for (const workflow of workflows) {
    const run = await runWorkflowForEvent(rt, workflow, event);
    runs.push(run.id);
  }
  rt.logger.info('automation reacted', {
    workspaceId: event.workspaceId,
    type: event.type,
    matched: workflows.length,
  });
  return { matched: workflows.length, runs };
}
