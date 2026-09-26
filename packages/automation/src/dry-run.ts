/**
 * Dry run (§14 "dry-run over the last 7 days of real data").
 *
 * Replays real history through a workflow's trigger + conditions and reports what *would* have
 * happened. Strictly read-only: it never calls `runWorkflowForEvent`, never writes a
 * `WorkflowRun`, and never touches an action. The reconstructed events are approximate — a
 * historical `TimelineEvent` does not carry everything a live ingest event does — which is why
 * this answers "would it have matched?", not "what exactly would it have produced?".
 */
import { Platform, loadAttributes, type TenantDb, type TimelineType } from '@nexus/db';
import { conditionsMatch } from './conditions.ts';
import { parseActions, parseTrigger, type AutomationEvent, type TriggerType } from './events.ts';
import { referencesRecord } from './context.ts';
import type { EvaluationContext } from './types.ts';

export type DryRunSample = {
  occurredAt: string;
  summary: string;
  wouldRunActions: string[];
};

export type DryRunReport = {
  windowDays: number;
  evaluated: number;
  matched: number;
  samples: DryRunSample[];
};

export const DRY_RUN_DEFAULT_DAYS = 7;
const MAX_SAMPLES = 20;
const MAX_CANDIDATES = 500;

/** Which `TimelineEvent.type` backs each timeline-shaped trigger. */
const TIMELINE_TRIGGERS: Partial<Record<TriggerType, TimelineType>> = {
  'message.received': 'MESSAGE',
  'comment.received': 'COMMENT',
  'mention.received': 'MENTION',
  'lead_form.submitted': 'LEAD_FORM',
  'ai.insight_produced': 'AI_INSIGHT',
};

function asPlatform(value: string | undefined): Platform | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  return upper in Platform ? (upper as Platform) : undefined;
}

function truncate(text: string, max = 140): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type Candidate = { event: AutomationEvent; summary: string; recordId: string | null };

/**
 * Replay the last N days of real data matching this workflow's trigger and report what would
 * have run. No side effects at all.
 */
export async function dryRun(
  db: TenantDb,
  workspaceId: string,
  workflow: { trigger: unknown; conditions: unknown; actions: unknown },
  opts?: { days?: number },
): Promise<DryRunReport> {
  const windowDays = opts?.days ?? DRY_RUN_DEFAULT_DAYS;
  const report: DryRunReport = { windowDays, evaluated: 0, matched: 0, samples: [] };

  const trigger = parseTrigger(workflow.trigger);
  const actions = parseActions(workflow.actions);
  const wouldRunActions = actions.map((a) => `${a.id}:${a.type}`);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const candidates = await collectCandidates(db, workspaceId, trigger, since);
  const needsRecord = referencesRecord(workflow.conditions);
  const recordCache = new Map<string, Record<string, unknown> | null>();

  for (const candidate of candidates) {
    report.evaluated += 1;
    const evaluation: EvaluationContext = { event: candidate.event };
    if (needsRecord && candidate.recordId) {
      if (!recordCache.has(candidate.recordId)) {
        recordCache.set(candidate.recordId, await loadRecordValues(db, candidate.recordId));
      }
      evaluation.record = recordCache.get(candidate.recordId) ?? null;
    } else if (needsRecord) {
      evaluation.record = null;
    }

    if (!conditionsMatch(workflow.conditions, evaluation)) continue;
    report.matched += 1;
    if (report.samples.length < MAX_SAMPLES) {
      report.samples.push({
        occurredAt: candidate.event.occurredAt,
        summary: candidate.summary,
        wouldRunActions,
      });
    }
  }
  return report;
}

/** Same slug-keyed shape `context.ts` builds, but without the extra object-type round trip. */
async function loadRecordValues(
  db: TenantDb,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.record.findFirst({
    where: { id: recordId, deletedAt: null },
    select: { id: true, objectTypeId: true, values: true },
  });
  if (!row) return null;
  const attributes = await loadAttributes(db, row.objectTypeId);
  const values = (row.values ?? {}) as Record<string, unknown>;
  const bySlug: Record<string, unknown> = {};
  for (const attribute of attributes) bySlug[attribute.apiSlug] = values[attribute.id] ?? null;
  return { ...bySlug, id: row.id, objectTypeId: row.objectTypeId, values };
}

async function collectCandidates(
  db: TenantDb,
  workspaceId: string,
  trigger: ReturnType<typeof parseTrigger>,
  since: Date,
): Promise<Candidate[]> {
  const timelineType = TIMELINE_TRIGGERS[trigger.type];
  if (timelineType) return timelineCandidates(db, workspaceId, trigger, timelineType, since);
  if (trigger.type === 'record.created' || trigger.type === 'record.updated') {
    return recordCandidates(db, workspaceId, trigger, since);
  }
  if (trigger.type === 'list.entry_added' || trigger.type === 'list.stage_changed') {
    return listCandidates(db, workspaceId, trigger, since);
  }
  // `schedule`, `webhook.inbound`, `sla.breach_imminent` and `task.overdue` leave no replayable
  // trail of their own, so there is nothing honest to replay.
  return [];
}

async function timelineCandidates(
  db: TenantDb,
  workspaceId: string,
  trigger: ReturnType<typeof parseTrigger>,
  type: TimelineType,
  since: Date,
): Promise<Candidate[]> {
  const platform = asPlatform(trigger.platform);
  const rows = await db.timelineEvent.findMany({
    where: {
      workspaceId,
      type,
      occurredAt: { gte: since },
      ...(platform ? { platform } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      occurredAt: true,
      platform: true,
      connectionId: true,
      recordId: true,
      identityId: true,
      payload: true,
      summary: true,
    },
  });

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // "message received" means inbound; an outbound reply is not a trigger.
    if (type === 'MESSAGE' && payload['direction'] === 'outbound') continue;
    candidates.push({
      event: {
        workspaceId,
        type: trigger.type,
        occurredAt: row.occurredAt.toISOString(),
        platform: row.platform,
        connectionId: row.connectionId,
        recordId: row.recordId,
        identityId: row.identityId,
        conversationId: null,
        timelineEventId: row.id,
        payload,
        causation: { workflowIds: [] },
      },
      summary: truncate(
        typeof payload['body'] === 'string' && payload['body'].length > 0
          ? payload['body']
          : row.summary,
      ),
      recordId: row.recordId,
    });
  }
  return candidates;
}

async function recordCandidates(
  db: TenantDb,
  workspaceId: string,
  trigger: ReturnType<typeof parseTrigger>,
  since: Date,
): Promise<Candidate[]> {
  let objectTypeId: string | undefined;
  if (trigger.objectTypeApiSlug) {
    const objectType = await db.objectType.findFirst({
      where: { workspaceId, apiSlug: trigger.objectTypeApiSlug, deletedAt: null },
      select: { id: true },
    });
    // A trigger narrowed to an object type that does not exist matches nothing.
    if (!objectType) return [];
    objectTypeId = objectType.id;
  }

  const created = trigger.type === 'record.created';
  const rows = await db.record.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(objectTypeId ? { objectTypeId } : {}),
      ...(created ? { createdAt: { gte: since } } : { updatedAt: { gte: since } }),
    },
    orderBy: created ? { createdAt: 'desc' } : { updatedAt: 'desc' },
    take: MAX_CANDIDATES,
    select: { id: true, objectTypeId: true, values: true, createdAt: true, updatedAt: true },
  });

  return rows.map((row) => ({
    event: {
      workspaceId,
      type: trigger.type,
      occurredAt: (created ? row.createdAt : row.updatedAt).toISOString(),
      recordId: row.id,
      objectTypeApiSlug: trigger.objectTypeApiSlug ?? null,
      payload: { values: row.values ?? {} },
      causation: { workflowIds: [] },
    } satisfies AutomationEvent,
    summary: `record ${row.id}`,
    recordId: row.id,
  }));
}

async function listCandidates(
  db: TenantDb,
  workspaceId: string,
  trigger: ReturnType<typeof parseTrigger>,
  since: Date,
): Promise<Candidate[]> {
  if (trigger.type === 'list.entry_added') {
    const rows = await db.listEntry.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        createdAt: { gte: since },
        ...(trigger.listId ? { listId: trigger.listId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
      select: { id: true, listId: true, recordId: true, stage: true, createdAt: true },
    });
    return rows.map((row) => ({
      event: {
        workspaceId,
        type: trigger.type,
        occurredAt: row.createdAt.toISOString(),
        listId: row.listId,
        entryId: row.id,
        recordId: row.recordId,
        payload: { stage: row.stage },
        causation: { workflowIds: [] },
      } satisfies AutomationEvent,
      summary: `entry ${row.id} added at stage ${row.stage ?? '—'}`,
      recordId: row.recordId,
    }));
  }

  const rows = await db.listStageHistory.findMany({
    where: {
      workspaceId,
      at: { gte: since },
      ...(trigger.listId ? { listEntry: { listId: trigger.listId } } : {}),
    },
    orderBy: { at: 'desc' },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      at: true,
      fromStage: true,
      toStage: true,
      listEntryId: true,
      listEntry: { select: { listId: true, recordId: true } },
    },
  });
  return rows.map((row) => ({
    event: {
      workspaceId,
      type: trigger.type,
      occurredAt: row.at.toISOString(),
      listId: row.listEntry.listId,
      entryId: row.listEntryId,
      recordId: row.listEntry.recordId,
      payload: { fromStage: row.fromStage, toStage: row.toStage },
      causation: { workflowIds: [] },
    } satisfies AutomationEvent,
    summary: `${row.fromStage ?? '—'} → ${row.toStage}`,
    recordId: row.listEntry.recordId,
  }));
}
