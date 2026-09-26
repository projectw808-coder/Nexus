/**
 * The automation vocabulary (spec §14): what can trigger a workflow, what a workflow can do, and
 * the plain-data envelope that carries "something happened" from wherever it happened into the
 * engine.
 *
 * `AutomationEvent` is deliberately the only surface other packages need (ADR-021 decision 1):
 * `@nexus/sync`'s stage 6 and `apps/web`'s record router both construct one without importing any
 * of this package's execution logic, and neither this package nor they gain a dependency on the
 * other's internals.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conditionSchema, type ConditionNode } from './conditions.ts';

// ── Triggers ──────────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  'record.created',
  'record.updated',
  'list.entry_added',
  'list.stage_changed',
  'message.received',
  'comment.received',
  'mention.received',
  'lead_form.submitted',
  'sla.breach_imminent',
  'task.overdue',
  'schedule',
  'webhook.inbound',
  'ai.insight_produced',
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const workflowTriggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  /** Narrows `record.created` / `record.updated` to one object type. */
  objectTypeApiSlug: z.string().optional(),
  /** Narrows `message`/`comment`/`mention.received`. Compared case-insensitively. */
  platform: z.string().optional(),
  /** Narrows `list.entry_added` / `list.stage_changed`. */
  listId: z.string().uuid().optional(),
  /** 5-field cron for the `schedule` trigger. Carried, not interpreted — the worker owns the
   *  BullMQ repeatable; this engine never schedules anything itself. */
  cron: z.string().optional(),
});

export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

// ── The event envelope ────────────────────────────────────────────────────────

export type AutomationEvent = {
  workspaceId: string;
  type: TriggerType;
  /** ISO-8601. */
  occurredAt: string;
  platform?: string | null;
  connectionId?: string | null;
  recordId?: string | null;
  objectTypeApiSlug?: string | null;
  identityId?: string | null;
  conversationId?: string | null;
  listId?: string | null;
  entryId?: string | null;
  timelineEventId?: string | null;
  payload: Record<string, unknown>;
  /** Loop detection (ADR-021 decision 3). Always present; empty array for a top-level event. */
  causation: { workflowIds: string[] };
};

export const automationEventSchema: z.ZodType<AutomationEvent> = z.object({
  workspaceId: z.string().min(1),
  type: z.enum(TRIGGER_TYPES),
  occurredAt: z.string().min(1),
  platform: z.string().nullish(),
  connectionId: z.string().nullish(),
  recordId: z.string().nullish(),
  objectTypeApiSlug: z.string().nullish(),
  identityId: z.string().nullish(),
  conversationId: z.string().nullish(),
  listId: z.string().nullish(),
  entryId: z.string().nullish(),
  timelineEventId: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()),
  causation: z.object({ workflowIds: z.array(z.string()) }),
});

/** Stable JSON: object keys sorted, so two structurally equal payloads hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The idempotency key for one (workflow, event) pair. Deterministic over everything that
 * identifies the event — but NOT over `causation`, so a redelivered or replayed event derives the
 * same key and the `(workflowId, triggerKey)` unique index stops the second run dead.
 */
export function triggerKeyFor(event: AutomationEvent): string {
  const material = stableStringify([
    event.type,
    event.occurredAt,
    event.platform ?? null,
    event.connectionId ?? null,
    event.recordId ?? null,
    event.objectTypeApiSlug ?? null,
    event.identityId ?? null,
    event.conversationId ?? null,
    event.listId ?? null,
    event.entryId ?? null,
    event.timelineEventId ?? null,
    event.payload,
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 48);
}

/** Does this trigger fire for this event? Narrowing fields only apply when the trigger sets them. */
export function triggerMatches(trigger: WorkflowTrigger, event: AutomationEvent): boolean {
  if (trigger.type !== event.type) return false;
  if (trigger.platform !== undefined) {
    const want = trigger.platform.toLowerCase();
    if ((event.platform ?? '').toLowerCase() !== want) return false;
  }
  if (
    trigger.objectTypeApiSlug !== undefined &&
    trigger.objectTypeApiSlug !== event.objectTypeApiSlug
  ) {
    return false;
  }
  if (trigger.listId !== undefined && trigger.listId !== event.listId) return false;
  return true;
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * A target id on an action. The sentinel `'trigger'` (and omitting the field entirely) resolves
 * from the triggering event; any other string is a literal id.
 */
export type TargetRef = string;

export type WorkflowAction =
  | { id: string; type: 'update_record'; recordId?: TargetRef; values: Record<string, unknown> }
  | {
      id: string;
      type: 'create_record';
      objectTypeApiSlug: string;
      values: Record<string, unknown>;
    }
  | {
      id: string;
      type: 'create_task';
      title: string;
      assigneeId?: string;
      dueInHours?: number;
      recordId?: TargetRef;
    }
  | { id: string; type: 'create_note'; text: string; recordId?: TargetRef }
  | { id: string; type: 'list_add'; listId: string; recordId?: TargetRef; stage?: string }
  | { id: string; type: 'list_remove'; listId: string; recordId?: TargetRef }
  | { id: string; type: 'stage_move'; entryId?: TargetRef; listId: string; toStage: string }
  | { id: string; type: 'assign'; conversationId?: TargetRef; mode: 'user'; userId: string }
  | {
      id: string;
      type: 'assign';
      conversationId?: TargetRef;
      mode: 'round_robin';
      candidateUserIds: string[];
    }
  | { id: string; type: 'send_reply'; conversationId?: TargetRef; text: string }
  | { id: string; type: 'send_email'; to: string; subject: string; body: string }
  | { id: string; type: 'call_webhook'; url: string; body?: Record<string, unknown> }
  | { id: string; type: 'enqueue_ai'; feature: string; payload: Record<string, unknown> }
  | { id: string; type: 'wait'; seconds: number }
  | {
      id: string;
      type: 'branch';
      condition: ConditionNode;
      then: WorkflowAction[];
      else?: WorkflowAction[];
    }
  | { id: string; type: 'run_workflow'; workflowId: string };

export type WorkflowActionType = WorkflowAction['type'];

const actionId = z.string().min(1);
const targetRef = z.string().min(1).optional();
const valuesBag = z.record(z.string(), z.unknown());

export const workflowActionSchema: z.ZodType<WorkflowAction> = z.lazy(() =>
  z.union([
    z.object({
      id: actionId,
      type: z.literal('update_record'),
      recordId: targetRef,
      values: valuesBag,
    }),
    z.object({
      id: actionId,
      type: z.literal('create_record'),
      objectTypeApiSlug: z.string().min(1),
      values: valuesBag,
    }),
    z.object({
      id: actionId,
      type: z.literal('create_task'),
      title: z.string().min(1),
      assigneeId: z.string().optional(),
      dueInHours: z.number().optional(),
      recordId: targetRef,
    }),
    z.object({
      id: actionId,
      type: z.literal('create_note'),
      text: z.string().min(1),
      recordId: targetRef,
    }),
    z.object({
      id: actionId,
      type: z.literal('list_add'),
      listId: z.string().min(1),
      recordId: targetRef,
      stage: z.string().optional(),
    }),
    z.object({
      id: actionId,
      type: z.literal('list_remove'),
      listId: z.string().min(1),
      recordId: targetRef,
    }),
    z.object({
      id: actionId,
      type: z.literal('stage_move'),
      entryId: targetRef,
      listId: z.string().min(1),
      toStage: z.string().min(1),
    }),
    z.object({
      id: actionId,
      type: z.literal('assign'),
      conversationId: targetRef,
      mode: z.literal('user'),
      userId: z.string().min(1),
    }),
    z.object({
      id: actionId,
      type: z.literal('assign'),
      conversationId: targetRef,
      mode: z.literal('round_robin'),
      candidateUserIds: z.array(z.string().min(1)).min(1),
    }),
    z.object({
      id: actionId,
      type: z.literal('send_reply'),
      conversationId: targetRef,
      text: z.string().min(1),
    }),
    z.object({
      id: actionId,
      type: z.literal('send_email'),
      to: z.string().min(1),
      subject: z.string(),
      body: z.string(),
    }),
    z.object({
      id: actionId,
      type: z.literal('call_webhook'),
      url: z.string().url(),
      body: valuesBag.optional(),
    }),
    z.object({
      id: actionId,
      type: z.literal('enqueue_ai'),
      feature: z.string().min(1),
      payload: valuesBag,
    }),
    z.object({ id: actionId, type: z.literal('wait'), seconds: z.number().min(0).max(86_400) }),
    z.object({
      id: actionId,
      type: z.literal('branch'),
      condition: conditionSchema,
      then: z.array(workflowActionSchema),
      else: z.array(workflowActionSchema).optional(),
    }),
    z.object({
      id: actionId,
      type: z.literal('run_workflow'),
      workflowId: z.string().min(1),
    }),
  ]),
);

export const workflowActionsSchema: z.ZodType<WorkflowAction[]> = z.array(workflowActionSchema);

/** Coerce a stored `Workflow.trigger` value. Throws `ZodError` on a malformed definition. */
export function parseTrigger(raw: unknown): WorkflowTrigger {
  return workflowTriggerSchema.parse(raw);
}

/** Coerce a stored `Workflow.actions` value. `null` / `{}` read as an empty list. */
export function parseActions(raw: unknown): WorkflowAction[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  return workflowActionsSchema.parse(raw);
}
