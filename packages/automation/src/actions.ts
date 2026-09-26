/**
 * Executing one action.
 *
 * Every action runs in its own short `withTenant` transaction rather than one long one wrapping
 * the whole run: a `wait` must not hold a transaction open, and a step that fails must not roll
 * back the steps before it — "full step-by-step run history with inputs/outputs" (§14) only means
 * something if a partial failure still shows you what *did* happen.
 *
 * Mutations that would themselves re-enter stage 6 (`update_record`, `create_record`, `list_add`,
 * `stage_move`) append the running workflow's id to the causation chain and hand the follow-on
 * event to the injected `enqueueEvent` (ADR-021 decision 3).
 */
import { NexusError } from '@nexus/core';
import {
  addEntry,
  createRecord,
  loadAttributes,
  moveEntry,
  publishEvent,
  removeEntry,
  updateRecord,
  writeAudit,
  type Actor,
  type AttributeRow,
  type Prisma,
  type TenantDb,
} from '@nexus/db';
import { evaluateCondition } from './conditions.ts';
import type { AutomationEvent, TargetRef, WorkflowAction } from './events.ts';
import { defaultCallWebhook, type AutomationRuntime } from './runtime.ts';
import type { EvaluationContext, RunStep, WorkflowRow, WorkflowRunRow } from './types.ts';

/** Thrown by an action to fail its own step with a readable message, never the whole run. */
export class ActionError extends Error {
  override readonly name = 'ActionError';
}

function fail(message: string): never {
  throw new ActionError(message);
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** `'trigger'` (or nothing at all) means "take it from the event". Anything else is a literal id. */
export function resolveRef(
  ref: TargetRef | undefined,
  fromEvent: string | null | undefined,
): string | null {
  if (ref === undefined || ref === 'trigger') return fromEvent ?? null;
  return ref;
}

/** Workflow authors write attribute slugs; `createRecord`/`updateRecord` want attribute ids. */
function mapValuesToAttributeIds(
  values: Record<string, unknown>,
  attributes: AttributeRow[],
): Record<string, unknown> {
  const bySlug = new Map(attributes.map((a) => [a.apiSlug, a.id]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    out[bySlug.get(key) ?? key] = value;
  }
  return out;
}

export type ActionContext = {
  rt: AutomationRuntime;
  workflow: WorkflowRow;
  actor: Actor;
  event: AutomationEvent;
  evaluation: EvaluationContext;
  /** Depth guard for nested `branch` bodies. */
  depth: number;
  /**
   * Run another workflow. Supplied by `engine.ts` so this module never imports the engine back —
   * the `run_workflow` action needs the full run machinery (idempotency, loop check, rate cap).
   */
  runChild: (workflow: WorkflowRow, event: AutomationEvent) => Promise<WorkflowRunRow>;
};

/** The event a mutation kicks back into stage 6, with this workflow recorded as its cause. */
function followOn(
  ctx: ActionContext,
  patch: Partial<AutomationEvent> & Pick<AutomationEvent, 'type'>,
): AutomationEvent {
  return {
    workspaceId: ctx.workflow.workspaceId,
    occurredAt: ctx.rt.now().toISOString(),
    payload: {},
    ...patch,
    causation: { workflowIds: [...ctx.event.causation.workflowIds, ctx.workflow.id] },
  };
}

// ── individual actions ────────────────────────────────────────────────────────

async function runUpdateRecord(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'update_record' }>,
): Promise<unknown> {
  const recordId = resolveRef(action.recordId, ctx.event.recordId);
  if (!recordId) fail('update_record: no record to update (the event carries no recordId).');

  const result = await ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const row = await db.record.findFirst({
      where: { id: recordId, deletedAt: null },
      select: { id: true, objectTypeId: true },
    });
    if (!row) fail(`update_record: record ${recordId} not found.`);
    const attributes = await loadAttributes(db, row.objectTypeId);
    const { after } = await updateRecord(db, ctx.actor, {
      recordId: row.id,
      attributes,
      input: mapValuesToAttributeIds(action.values, attributes),
    });
    const objectType = await db.objectType.findFirst({
      where: { id: row.objectTypeId },
      select: { apiSlug: true },
    });
    return { recordId: after.id, objectTypeApiSlug: objectType?.apiSlug ?? null };
  });

  await ctx.rt.enqueueEvent(
    followOn(ctx, {
      type: 'record.updated',
      recordId: result.recordId,
      objectTypeApiSlug: result.objectTypeApiSlug,
      payload: { changed: Object.keys(action.values) },
    }),
  );
  return result;
}

async function runCreateRecord(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'create_record' }>,
): Promise<unknown> {
  const created = await ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const objectType = await db.objectType.findFirst({
      where: { apiSlug: action.objectTypeApiSlug, deletedAt: null },
      select: { id: true },
    });
    if (!objectType) fail(`create_record: no object type "${action.objectTypeApiSlug}".`);
    const attributes = await loadAttributes(db, objectType.id);
    const row = await createRecord(db, ctx.actor, {
      objectTypeId: objectType.id,
      attributes,
      input: mapValuesToAttributeIds(action.values, attributes),
    });
    return { recordId: row.id };
  });

  await ctx.rt.enqueueEvent(
    followOn(ctx, {
      type: 'record.created',
      recordId: created.recordId,
      objectTypeApiSlug: action.objectTypeApiSlug,
      payload: {},
    }),
  );
  return created;
}

async function runCreateTask(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'create_task' }>,
): Promise<unknown> {
  const recordId = resolveRef(action.recordId, ctx.event.recordId);
  const dueAt =
    action.dueInHours === undefined
      ? null
      : new Date(ctx.rt.now().getTime() + action.dueInHours * 3_600_000);

  return ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const task = await db.task.create({
      data: {
        workspaceId: ctx.actor.workspaceId,
        title: action.title,
        assigneeId: action.assigneeId ?? null,
        dueAt,
        recordId,
        conversationId: ctx.event.conversationId ?? null,
      },
      select: { id: true },
    });
    await writeAudit(db, ctx.actor, {
      action: 'task.created',
      targetType: 'Task',
      targetId: task.id,
      diff: { title: action.title, assigneeId: action.assigneeId ?? null, recordId },
    });
    return { taskId: task.id, dueAt: dueAt?.toISOString() ?? null };
  });
}

async function runCreateNote(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'create_note' }>,
): Promise<unknown> {
  const recordId = resolveRef(action.recordId, ctx.event.recordId);
  if (!recordId && !ctx.event.conversationId) {
    fail('create_note: no record or conversation to file the note against.');
  }
  return ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const note = await db.note.create({
      data: {
        workspaceId: ctx.actor.workspaceId,
        recordId,
        conversationId: ctx.event.conversationId ?? null,
        body: action.text,
      },
      select: { id: true },
    });
    await writeAudit(db, ctx.actor, {
      action: 'note.created',
      targetType: 'Note',
      targetId: note.id,
      diff: { recordId },
    });
    return { noteId: note.id };
  });
}

async function runListAdd(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'list_add' }>,
): Promise<unknown> {
  const recordId = resolveRef(action.recordId, ctx.event.recordId);
  if (!recordId) fail('list_add: no record to add (the event carries no recordId).');

  const result = await ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const existing = await db.listEntry.findFirst({
      where: { listId: action.listId, recordId, deletedAt: null },
      select: { id: true, stage: true },
    });
    if (existing) return { entryId: existing.id, stage: existing.stage, alreadyPresent: true };
    const entry = await addEntry(db, ctx.actor, {
      listId: action.listId,
      recordId,
      stage: action.stage,
    });
    return { entryId: entry.id, stage: entry.stage, alreadyPresent: false };
  });

  if (!result.alreadyPresent) {
    await ctx.rt.enqueueEvent(
      followOn(ctx, {
        type: 'list.entry_added',
        listId: action.listId,
        entryId: result.entryId,
        recordId,
        payload: { stage: result.stage },
      }),
    );
  }
  return result;
}

async function runListRemove(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'list_remove' }>,
): Promise<unknown> {
  const recordId = resolveRef(action.recordId, ctx.event.recordId);
  if (!recordId) fail('list_remove: no record to remove (the event carries no recordId).');

  return ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const entry = await db.listEntry.findFirst({
      where: { listId: action.listId, recordId, deletedAt: null },
      select: { id: true },
    });
    if (!entry) return { removed: false, reason: 'the record is not in this list' };
    await removeEntry(db, entry.id);
    return { removed: true, entryId: entry.id };
  });
}

async function runStageMove(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'stage_move' }>,
): Promise<unknown> {
  const explicit = resolveRef(action.entryId, ctx.event.entryId);
  const eventRecordId = ctx.event.recordId ?? null;

  const result = await ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    let entryId = explicit;
    if (!entryId && eventRecordId) {
      const found = await db.listEntry.findFirst({
        where: { listId: action.listId, recordId: eventRecordId, deletedAt: null },
        select: { id: true },
      });
      entryId = found?.id ?? null;
    }
    if (!entryId) fail('stage_move: no list entry to move.');
    const before = await db.listEntry.findFirst({
      where: { id: entryId, deletedAt: null },
      select: { stage: true, recordId: true },
    });
    const moved = await moveEntry(db, ctx.actor, { entryId, stage: action.toStage });
    return {
      entryId: moved.id,
      fromStage: before?.stage ?? null,
      toStage: moved.stage,
      recordId: before?.recordId ?? eventRecordId,
    };
  });

  await ctx.rt.enqueueEvent(
    followOn(ctx, {
      type: 'list.stage_changed',
      listId: action.listId,
      entryId: result.entryId,
      recordId: result.recordId,
      payload: { fromStage: result.fromStage, toStage: result.toStage },
    }),
  );
  return result;
}

/**
 * Pick the next assignee. `mode: 'user'` is fixed; `mode: 'round_robin'` advances a cursor kept in
 * `Workflow.state[action.id]` — a persistent "who got the last one", which counting `WorkflowRun`
 * rows cannot answer (ADR-021).
 */
async function pickAssignee(
  db: TenantDb,
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'assign' }>,
): Promise<string> {
  if (action.mode === 'user') return action.userId;

  const row = await db.workflow.findFirst({
    where: { id: ctx.workflow.id, deletedAt: null },
    select: { state: true },
  });
  const state = (row?.state ?? {}) as Record<string, unknown>;
  const slot = (state[action.id] ?? {}) as { index?: unknown };
  const previous = typeof slot.index === 'number' ? slot.index : -1;
  const next = (previous + 1) % action.candidateUserIds.length;
  const userId = action.candidateUserIds[next];
  if (userId === undefined) fail('assign: round_robin has no candidates.');

  await db.workflow.update({
    where: { id: ctx.workflow.id },
    data: {
      state: asJson({
        ...state,
        [action.id]: { index: next, lastUserId: userId, at: ctx.rt.now().toISOString() },
      }),
    },
  });
  return userId;
}

async function runAssign(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'assign' }>,
): Promise<unknown> {
  const conversationId = resolveRef(action.conversationId, ctx.event.conversationId);
  if (!conversationId) fail('assign: no conversation to assign (the event carries none).');

  return ctx.rt.runtime.withTenant(ctx.actor, async (db) => {
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, deletedAt: null },
      select: { id: true },
    });
    if (!conversation) fail(`assign: conversation ${conversationId} not found.`);

    const userId = await pickAssignee(db, ctx, action);
    await db.conversation.update({ where: { id: conversationId }, data: { assigneeId: userId } });
    await publishEvent(db, {
      workspaceId: ctx.actor.workspaceId,
      topic: 'conversation.changed',
      payload: { ids: [conversationId], field: 'assignee' },
    });
    await writeAudit(db, ctx.actor, {
      action: 'conversation.assigned',
      targetType: 'Conversation',
      targetId: conversationId,
      diff: { to: userId },
    });
    return { conversationId, assigneeId: userId, mode: action.mode };
  });
}

async function runSendReply(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'send_reply' }>,
): Promise<unknown> {
  const conversationId = resolveRef(action.conversationId, ctx.event.conversationId);
  if (!conversationId) fail('send_reply: no conversation to reply to.');
  const send = ctx.rt.sendReply;
  if (!send) fail('send_reply: no sendReply callback was injected into the automation runtime.');
  const result = await send({
    workspaceId: ctx.actor.workspaceId,
    actorUserId: null,
    conversationId,
    text: action.text,
  });
  return { conversationId, ...result };
}

async function runSendEmail(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'send_email' }>,
): Promise<unknown> {
  const send = ctx.rt.sendEmail;
  if (!send) fail('send_email: no sendEmail callback was injected into the automation runtime.');
  await send({ to: action.to, subject: action.subject, body: action.body });
  return { to: action.to, subject: action.subject };
}

async function runCallWebhook(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'call_webhook' }>,
): Promise<unknown> {
  const call = ctx.rt.callWebhook ?? defaultCallWebhook;
  const body = action.body ?? {
    workflowId: ctx.workflow.id,
    workflowName: ctx.workflow.name,
    event: ctx.event,
  };
  const { status } = await call(action.url, body);
  if (status < 200 || status >= 300) fail(`call_webhook: ${action.url} returned ${status}.`);
  return { url: action.url, status };
}

async function runEnqueueAi(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'enqueue_ai' }>,
): Promise<unknown> {
  const enqueue = ctx.rt.enqueueAi;
  if (!enqueue) fail('enqueue_ai: no enqueueAi callback was injected into the automation runtime.');
  await enqueue({
    workspaceId: ctx.actor.workspaceId,
    feature: action.feature,
    payload: action.payload,
  });
  return { feature: action.feature };
}

async function runRunWorkflow(
  ctx: ActionContext,
  action: Extract<WorkflowAction, { type: 'run_workflow' }>,
): Promise<unknown> {
  const target = await ctx.rt.runtime.withTenant(ctx.actor, (db) =>
    db.workflow.findFirst({
      where: { id: action.workflowId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        enabled: true,
        trigger: true,
        conditions: true,
        actions: true,
        version: true,
        state: true,
      },
    }),
  );
  if (!target) fail(`run_workflow: workflow ${action.workflowId} not found.`);
  if (!target.enabled) fail(`run_workflow: workflow ${action.workflowId} is disabled.`);

  // Append our own id before recursing: the child sees us in its causation chain, so a cycle
  // (A → B → A) is caught by the same check that catches a workflow re-triggering itself.
  const childEvent: AutomationEvent = {
    ...ctx.event,
    causation: { workflowIds: [...ctx.event.causation.workflowIds, ctx.workflow.id] },
  };
  const run = await ctx.runChild(target, childEvent);
  return { workflowId: target.id, runId: run.id, status: run.status, error: run.error };
}

// ── the dispatcher ────────────────────────────────────────────────────────────

const MAX_BRANCH_DEPTH = 10;

type LeafAction = Exclude<WorkflowAction, { type: 'branch' }>;

async function executeLeaf(ctx: ActionContext, action: LeafAction): Promise<unknown> {
  switch (action.type) {
    case 'update_record':
      return runUpdateRecord(ctx, action);
    case 'create_record':
      return runCreateRecord(ctx, action);
    case 'create_task':
      return runCreateTask(ctx, action);
    case 'create_note':
      return runCreateNote(ctx, action);
    case 'list_add':
      return runListAdd(ctx, action);
    case 'list_remove':
      return runListRemove(ctx, action);
    case 'stage_move':
      return runStageMove(ctx, action);
    case 'assign':
      return runAssign(ctx, action);
    case 'send_reply':
      return runSendReply(ctx, action);
    case 'send_email':
      return runSendEmail(ctx, action);
    case 'call_webhook':
      return runCallWebhook(ctx, action);
    case 'enqueue_ai':
      return runEnqueueAi(ctx, action);
    case 'wait': {
      const resumeAt = new Date(ctx.rt.now().getTime() + action.seconds * 1000).toISOString();
      await ctx.rt.sleep(action.seconds * 1000);
      return { seconds: action.seconds, resumeAt };
    }
    case 'run_workflow':
      return runRunWorkflow(ctx, action);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ActionError) return error.message;
  if (NexusError.is(error)) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function recordFailure(
  ctx: ActionContext,
  action: WorkflowAction,
  at: string,
  error: unknown,
): RunStep {
  const message = messageOf(error);
  ctx.rt.logger.warn('automation action failed', {
    workflowId: ctx.workflow.id,
    actionId: action.id,
    type: action.type,
    error: message,
  });
  return { actionId: action.id, type: action.type, at, ok: false, error: message };
}

/**
 * Run a list of actions in order, appending one `RunStep` each. A failing action records a failed
 * step and execution continues — a partial failure still leaves a readable run history. A
 * `branch` records its own step first, then its chosen body's steps follow in order.
 */
export async function executeActions(
  ctx: ActionContext,
  actions: WorkflowAction[],
  steps: RunStep[],
): Promise<RunStep[]> {
  for (const action of actions) {
    const at = ctx.rt.now().toISOString();

    if (action.type === 'branch') {
      let body: WorkflowAction[];
      let taken: boolean;
      try {
        if (ctx.depth >= MAX_BRANCH_DEPTH) fail('branch: nested too deep.');
        taken = evaluateCondition(action.condition, ctx.evaluation);
        body = taken ? action.then : (action.else ?? []);
      } catch (error) {
        steps.push(recordFailure(ctx, action, at, error));
        continue;
      }
      steps.push({
        actionId: action.id,
        type: 'branch',
        at,
        ok: true,
        output: { taken: taken ? 'then' : 'else', actions: body.length },
      });
      await executeActions({ ...ctx, depth: ctx.depth + 1 }, body, steps);
      continue;
    }

    try {
      const output = await executeLeaf(ctx, action);
      steps.push({ actionId: action.id, type: action.type, at, ok: true, output });
    } catch (error) {
      steps.push(recordFailure(ctx, action, at, error));
    }
  }
  return steps;
}
