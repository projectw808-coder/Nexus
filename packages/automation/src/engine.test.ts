/**
 * The Phase 10 acceptance criterion (spec §16): "a workflow that routes Instagram comments
 * containing 'price' to a pipeline and assigns by round-robin passes a 7-day dry run and then
 * runs live" — plus the safety rails §14 makes mandatory around it.
 *
 * Everything runs against a real Postgres (PGlite, migrations applied). Nothing about the
 * database is mocked; only the injected side-effect callbacks are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createList,
  createRecord,
  emitTimelineEvent,
  loadAttributes,
  personAttributes,
  systemActorFor,
  type Actor,
} from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { dryRun } from './dry-run.ts';
import { matchWorkflows, reactToEvent, runWorkflowForEvent } from './engine.ts';
import { triggerKeyFor, type AutomationEvent, type WorkflowAction } from './events.ts';
import { createAutomationRuntime, type AutomationRuntime } from './runtime.ts';
import type { RunStep, WorkflowRow } from './types.ts';

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let ownerId: string;
let agentA: string;
let agentB: string;
let connectionId: string;
let listId: string;
let personTypeId: string;
let commenterRecordId: string;

const STAGES = [
  { id: 'new', label: 'New' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'won', label: 'Won' },
];

// ── injected runtime ──────────────────────────────────────────────────────────

type Harness = {
  rt: AutomationRuntime;
  enqueued: AutomationEvent[];
  replies: { conversationId: string; text: string }[];
  emails: { to: string; subject: string }[];
  webhooks: { url: string; body: unknown }[];
  aiJobs: { feature: string }[];
  slept: number[];
};

function harness(overrides: Partial<AutomationRuntime> = {}): Harness {
  const enqueued: AutomationEvent[] = [];
  const replies: { conversationId: string; text: string }[] = [];
  const emails: { to: string; subject: string }[] = [];
  const webhooks: { url: string; body: unknown }[] = [];
  const aiJobs: { feature: string }[] = [];
  const slept: number[] = [];

  const rt = createAutomationRuntime({
    runtime: db.runtime,
    enqueueEvent: async (event) => {
      enqueued.push(event);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    sendReply: async ({ conversationId, text }) => {
      replies.push({ conversationId, text });
      return { status: 'QUEUED', outboundActionId: 'outbound-1' };
    },
    sendEmail: async ({ to, subject }) => {
      emails.push({ to, subject });
    },
    callWebhook: async (url, body) => {
      webhooks.push({ url, body });
      return { status: 202 };
    },
    enqueueAi: async ({ feature }) => {
      aiJobs.push({ feature });
    },
    ...overrides,
  });
  return { rt, enqueued, replies, emails, webhooks, aiJobs, slept };
}

// ── seeding helpers ───────────────────────────────────────────────────────────

const person = (values: Record<string, unknown>) =>
  db.runtime.withTenant(actor, async (t) => {
    const pa = await personAttributes(t);
    const attributes = await loadAttributes(t, pa.objectTypeId);
    const bySlug = Object.fromEntries(attributes.map((a) => [a.apiSlug, a.id]));
    return createRecord(t, actor, {
      objectTypeId: pa.objectTypeId,
      attributes,
      input: Object.fromEntries(Object.entries(values).map(([k, v]) => [bySlug[k]!, v])),
    });
  });

async function seedConversation(externalId: string, personRecordId?: string) {
  return db.runtime.withTenant(actor, (t) =>
    t.conversation.create({
      data: {
        workspaceId,
        connectionId,
        platform: 'INSTAGRAM',
        kind: 'COMMENT_THREAD',
        externalId,
        personRecordId: personRecordId ?? null,
      },
      select: { id: true },
    }),
  );
}

async function createWorkflow(input: {
  name: string;
  trigger: unknown;
  conditions?: unknown;
  actions: WorkflowAction[];
  enabled?: boolean;
}): Promise<WorkflowRow> {
  return db.runtime.withTenant(actor, (t) =>
    t.workflow.create({
      data: {
        workspaceId,
        name: input.name,
        enabled: input.enabled ?? true,
        trigger: input.trigger as object,
        conditions: input.conditions ?? {},
        actions: input.actions as unknown as object,
        createdById: ownerId,
      },
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
}

function commentEvent(over: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    workspaceId,
    type: 'comment.received',
    occurredAt: '2026-09-24T09:00:00.000Z',
    platform: 'INSTAGRAM',
    connectionId,
    recordId: commenterRecordId,
    payload: { body: 'Hi! what is the price?', direction: 'inbound' },
    causation: { workflowIds: [] },
    ...over,
  };
}

const stepsOf = (run: { steps: unknown }) => (run.steps ?? []) as RunStep[];
const stepFor = (run: { steps: unknown }, actionId: string) =>
  stepsOf(run).find((s) => s.actionId === actionId);

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await createTestDatabase();

  const owner = await db.prisma.user.create({
    data: { email: 'owner@automation.test', name: 'Owner' },
  });
  ownerId = owner.id;
  const a = await db.prisma.user.create({ data: { email: 'a@automation.test', name: 'Agent A' } });
  const b = await db.prisma.user.create({ data: { email: 'b@automation.test', name: 'Agent B' } });
  agentA = a.id;
  agentB = b.id;

  const ws = await db.tenancy.createWorkspace({
    name: 'Automation',
    slug: 'automation',
    ownerUserId: ownerId,
  });
  workspaceId = ws.id;
  actor = { ...systemActorFor(ws.id), userId: ownerId, actorType: 'USER' };

  await db.runtime.withTenant(actor, async (t) => {
    const connection = await t.connection.create({
      data: {
        workspaceId,
        platform: 'INSTAGRAM',
        label: 'Instagram — Acme',
        accountExternalId: 'ig_acme',
        accountName: 'Acme',
        apiVersion: 'v26.0',
        tokenRef: 'vault:test',
        ownerUserId: ownerId,
      },
      select: { id: true },
    });
    connectionId = connection.id;

    const pa = await personAttributes(t);
    personTypeId = pa.objectTypeId;
    const list = await createList(t, actor, {
      objectTypeId: personTypeId,
      name: 'Price enquiries',
      kind: 'PIPELINE',
      stages: STAGES,
    });
    listId = list.id;
  });

  const commenter = await person({ name: 'Dana Wholesale', email: 'dana@wholesale.test' });
  commenterRecordId = commenter.id;
}, 180_000);

afterAll(async () => {
  await db?.close();
});

// ── the acceptance criterion ──────────────────────────────────────────────────

describe('Instagram comments containing "price" → pipeline + round-robin', () => {
  const PRICE_TRIGGER = { type: 'comment.received', platform: 'INSTAGRAM' };
  const PRICE_CONDITION = {
    leaf: { path: 'event.payload.body', op: 'contains', value: 'price' },
  };
  const priceActions = (): WorkflowAction[] => [
    { id: 'a1', type: 'list_add', listId, recordId: 'trigger', stage: 'new' },
    {
      id: 'a2',
      type: 'assign',
      conversationId: 'trigger',
      mode: 'round_robin',
      candidateUserIds: [agentA, agentB],
    },
  ];

  beforeAll(async () => {
    // Seven days of real history: four Instagram comments, two of which mention price, plus one
    // that does and one on another platform — the dry run must count only the right ones.
    const history: { body: string; days: number; platform: 'INSTAGRAM' | 'FACEBOOK' }[] = [
      { body: 'Love this! what is the price?', days: 1, platform: 'INSTAGRAM' },
      { body: 'Do you ship to Berlin?', days: 2, platform: 'INSTAGRAM' },
      { body: 'PRICE please 🙏', days: 3, platform: 'INSTAGRAM' },
      { body: 'Nice photo', days: 4, platform: 'INSTAGRAM' },
      { body: 'price?', days: 2, platform: 'FACEBOOK' },
      { body: 'what is the price', days: 30, platform: 'INSTAGRAM' },
    ];
    await db.runtime.withTenant(actor, async (t) => {
      let index = 0;
      for (const item of history) {
        index += 1;
        await emitTimelineEvent(t, {
          workspaceId,
          dedupeKey: `hist-${index}`,
          type: 'COMMENT',
          occurredAt: new Date(Date.now() - item.days * 86_400_000),
          summary: item.body,
          recordId: commenterRecordId,
          platform: item.platform,
          connectionId: item.platform === 'INSTAGRAM' ? connectionId : null,
          payload: {
            body: item.body,
            direction: 'inbound',
            conversationExternalId: `thread-${index}`,
          },
        });
      }
    });
  }, 60_000);

  it('passes a 7-day dry run without touching the database', async () => {
    const before = await db.runtime.withTenant(actor, (t) =>
      t.listEntry.count({ where: { listId } }),
    );
    expect(before).toBe(0);

    const report = await db.runtime.withTenant(actor, (t) =>
      dryRun(t, workspaceId, {
        trigger: PRICE_TRIGGER,
        conditions: PRICE_CONDITION,
        actions: priceActions(),
      }),
    );

    expect(report.windowDays).toBe(7);
    // Four Instagram comments inside the window (the Facebook one and the 30-day-old one are out).
    expect(report.evaluated).toBe(4);
    expect(report.matched).toBe(2);
    expect(report.samples).toHaveLength(2);
    expect(report.samples[0]?.wouldRunActions).toEqual(['a1:list_add', 'a2:assign']);

    // No side effects whatsoever.
    const after = await db.runtime.withTenant(actor, async (t) => ({
      entries: await t.listEntry.count({ where: { listId } }),
      runs: await t.workflowRun.count({}),
      assigned: await t.conversation.count({ where: { assigneeId: { not: null } } }),
    }));
    expect(after).toEqual({ entries: 0, runs: 0, assigned: 0 });
  });

  it('runs live: adds to the pipeline and assigns round-robin, advancing the cursor', async () => {
    const workflow = await createWorkflow({
      name: 'Price enquiries → pipeline',
      trigger: PRICE_TRIGGER,
      conditions: PRICE_CONDITION,
      actions: priceActions(),
    });
    const h = harness();

    const first = await seedConversation('live-thread-1', commenterRecordId);
    const firstEvent = commentEvent({ conversationId: first.id });
    const firstResult = await reactToEvent(h.rt, firstEvent);

    expect(firstResult.matched).toBe(1);
    expect(firstResult.runs).toHaveLength(1);

    const run = await db.runtime.withTenant(actor, (t) =>
      t.workflowRun.findFirstOrThrow({ where: { id: firstResult.runs[0] } }),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(run.triggerKey).toBe(triggerKeyFor(firstEvent));
    expect(stepsOf(run).map((s) => [s.type, s.ok])).toEqual([
      ['list_add', true],
      ['assign', true],
    ]);

    const entries = await db.runtime.withTenant(actor, (t) =>
      t.listEntry.findMany({ where: { listId, deletedAt: null } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recordId).toBe(commenterRecordId);
    expect(entries[0]?.stage).toBe('new');

    const firstConversation = await db.runtime.withTenant(actor, (t) =>
      t.conversation.findFirstOrThrow({ where: { id: first.id } }),
    );
    expect(firstConversation.assigneeId).toBe(agentA);

    // A second, different comment on a different conversation goes to the other agent.
    const other = await person({ name: 'Eli Buyer', email: 'eli@buyer.test' });
    const second = await seedConversation('live-thread-2', other.id);
    const secondEvent = commentEvent({
      conversationId: second.id,
      recordId: other.id,
      occurredAt: '2026-09-24T10:00:00.000Z',
      payload: { body: 'and the price for 10?', direction: 'inbound' },
    });
    await reactToEvent(h.rt, secondEvent);

    const secondConversation = await db.runtime.withTenant(actor, (t) =>
      t.conversation.findFirstOrThrow({ where: { id: second.id } }),
    );
    expect(secondConversation.assigneeId).toBe(agentB);

    // The cursor lives on Workflow.state, keyed by the action's own id.
    const state = await db.runtime.withTenant(actor, (t) =>
      t.workflow.findFirstOrThrow({ where: { id: workflow.id }, select: { state: true } }),
    );
    expect(
      (state.state as Record<string, { index: number; lastUserId: string }>)['a2'],
    ).toMatchObject({
      index: 1,
      lastUserId: agentB,
    });

    // list_add published a follow-on event with this workflow in the causation chain.
    expect(h.enqueued.filter((e) => e.type === 'list.entry_added')).toHaveLength(2);
    expect(h.enqueued[0]?.causation.workflowIds).toEqual([workflow.id]);

    // ── redelivery of the very same event is a no-op ─────────────────────────
    const redelivery = await reactToEvent(h.rt, firstEvent);
    expect(redelivery.runs).toEqual([run.id]);

    const afterRedelivery = await db.runtime.withTenant(actor, async (t) => ({
      entries: await t.listEntry.count({ where: { listId, deletedAt: null } }),
      runs: await t.workflowRun.count({ where: { workflowId: workflow.id } }),
      first: await t.conversation.findFirstOrThrow({ where: { id: first.id } }),
    }));
    expect(afterRedelivery.entries).toBe(2);
    expect(afterRedelivery.runs).toBe(2);
    expect(afterRedelivery.first.assigneeId).toBe(agentA); // not re-assigned to the next agent

    // ── a comment without "price" runs no actions at all ─────────────────────
    const third = await seedConversation('live-thread-3', commenterRecordId);
    const quiet = await reactToEvent(
      h.rt,
      commentEvent({
        conversationId: third.id,
        occurredAt: '2026-09-24T11:00:00.000Z',
        payload: { body: 'Do you ship to Berlin?', direction: 'inbound' },
      }),
    );
    expect(quiet.matched).toBe(1);
    const quietRun = await db.runtime.withTenant(actor, (t) =>
      t.workflowRun.findFirstOrThrow({ where: { id: quiet.runs[0] } }),
    );
    expect(quietRun.status).toBe('SUCCEEDED');
    expect(stepsOf(quietRun)).toEqual([]);
    expect((quietRun.context as { conditionsMatched?: boolean }).conditionsMatched).toBe(false);
    const stillUnassigned = await db.runtime.withTenant(actor, (t) =>
      t.conversation.findFirstOrThrow({ where: { id: third.id } }),
    );
    expect(stillUnassigned.assigneeId).toBeNull();
  }, 120_000);
});

// ── trigger matching ──────────────────────────────────────────────────────────

describe('matchWorkflows', () => {
  it('matches on type and narrows on platform, object type and list', async () => {
    const igOnly = await createWorkflow({
      name: 'ig comments',
      trigger: { type: 'comment.received', platform: 'instagram' },
      actions: [],
    });
    const anyPlatform = await createWorkflow({
      name: 'any comments',
      trigger: { type: 'comment.received' },
      actions: [],
    });
    const messages = await createWorkflow({
      name: 'messages',
      trigger: { type: 'message.received' },
      actions: [],
    });
    const disabled = await createWorkflow({
      name: 'disabled ig',
      trigger: { type: 'comment.received', platform: 'INSTAGRAM' },
      actions: [],
      enabled: false,
    });

    const matched = await db.runtime.withTenant(actor, (t) =>
      matchWorkflows(t, workspaceId, commentEvent({ conversationId: null })),
    );
    const ids = matched.map((w) => w.id);
    expect(ids).toContain(igOnly.id); // platform compared case-insensitively
    expect(ids).toContain(anyPlatform.id);
    expect(ids).not.toContain(messages.id);
    expect(ids).not.toContain(disabled.id);

    const facebook = await db.runtime.withTenant(actor, (t) =>
      matchWorkflows(t, workspaceId, commentEvent({ platform: 'FACEBOOK', conversationId: null })),
    );
    expect(facebook.map((w) => w.id)).not.toContain(igOnly.id);

    await db.runtime.withTenant(actor, (t) =>
      t.workflow.updateMany({
        where: { id: { in: [igOnly.id, anyPlatform.id, messages.id, disabled.id] } },
        data: { enabled: false },
      }),
    );
  }, 60_000);

  it('skips a workflow whose trigger JSON does not parse', async () => {
    const broken = await createWorkflow({
      name: 'broken trigger',
      trigger: { type: 'not.a.real.trigger' },
      actions: [],
    });
    const matched = await db.runtime.withTenant(actor, (t) =>
      matchWorkflows(t, workspaceId, commentEvent({ conversationId: null })),
    );
    expect(matched.map((w) => w.id)).not.toContain(broken.id);
    await db.runtime.withTenant(actor, (t) =>
      t.workflow.update({ where: { id: broken.id }, data: { enabled: false } }),
    );
  }, 60_000);
});

// ── safety rails ──────────────────────────────────────────────────────────────

describe('safety rails', () => {
  it('cancels a run whose causation chain already contains this workflow, before any action', async () => {
    const workflow = await createWorkflow({
      name: 'self-retriggering updater',
      trigger: { type: 'record.updated' },
      actions: [
        { id: 'u1', type: 'update_record', recordId: 'trigger', values: { name: 'Looped' } },
      ],
    });
    const h = harness();

    const before = await db.runtime.withTenant(actor, (t) =>
      t.record.findFirstOrThrow({ where: { id: commenterRecordId }, select: { values: true } }),
    );

    const run = await runWorkflowForEvent(h.rt, workflow, {
      workspaceId,
      type: 'record.updated',
      occurredAt: '2026-09-24T12:00:00.000Z',
      recordId: commenterRecordId,
      payload: {},
      causation: { workflowIds: [workflow.id] },
    });

    expect(run.status).toBe('CANCELLED');
    expect(run.error).toContain('loop_detected');
    expect(stepsOf(run)).toEqual([]);
    expect(h.enqueued).toEqual([]);

    const after = await db.runtime.withTenant(actor, (t) =>
      t.record.findFirstOrThrow({ where: { id: commenterRecordId }, select: { values: true } }),
    );
    expect(after.values).toEqual(before.values);
  }, 60_000);

  it('cancels a causation chain longer than ten', async () => {
    const workflow = await createWorkflow({
      name: 'deep chain',
      trigger: { type: 'record.updated' },
      actions: [{ id: 'n1', type: 'create_note', text: 'should never run' }],
    });
    const h = harness();
    const run = await runWorkflowForEvent(h.rt, workflow, {
      workspaceId,
      type: 'record.updated',
      occurredAt: '2026-09-24T12:05:00.000Z',
      recordId: commenterRecordId,
      payload: {},
      causation: { workflowIds: Array.from({ length: 11 }, (_, i) => `other-${i}`) },
    });
    expect(run.status).toBe('CANCELLED');
    expect(run.error).toBe('loop_detected: chain too deep');
  }, 60_000);

  it('enforces a per-workflow rate cap', async () => {
    const workflow = await createWorkflow({
      name: 'chatty',
      trigger: { type: 'record.updated' },
      actions: [{ id: 'n1', type: 'create_note', text: 'capped?', recordId: 'trigger' }],
    });
    const h = harness();
    const event = (n: number): AutomationEvent => ({
      workspaceId,
      type: 'record.updated',
      occurredAt: `2026-09-24T13:0${n}:00.000Z`,
      recordId: commenterRecordId,
      payload: { n },
      causation: { workflowIds: [] },
    });

    const one = await runWorkflowForEvent(h.rt, workflow, event(1), { rateCapPerHour: 2 });
    const two = await runWorkflowForEvent(h.rt, workflow, event(2), { rateCapPerHour: 2 });
    const three = await runWorkflowForEvent(h.rt, workflow, event(3), { rateCapPerHour: 2 });

    expect(one.status).toBe('SUCCEEDED');
    expect(two.status).toBe('SUCCEEDED');
    expect(three.status).toBe('CANCELLED');
    expect(three.error).toContain('rate_capped');
    expect(stepsOf(three)).toEqual([]);
  }, 60_000);

  it('records a failed step and keeps going instead of aborting the run', async () => {
    const workflow = await createWorkflow({
      name: 'partial failure',
      trigger: { type: 'record.updated' },
      actions: [
        {
          id: 'bad',
          type: 'list_add',
          listId: '00000000-0000-4000-8000-000000000000',
          recordId: 'trigger',
        },
        { id: 'good', type: 'create_note', text: 'still ran', recordId: 'trigger' },
      ],
    });
    const h = harness();
    const run = await runWorkflowForEvent(h.rt, workflow, {
      workspaceId,
      type: 'record.updated',
      occurredAt: '2026-09-24T14:00:00.000Z',
      recordId: commenterRecordId,
      payload: {},
      causation: { workflowIds: [] },
    });

    expect(run.status).toBe('FAILED');
    expect(stepFor(run, 'bad')?.ok).toBe(false);
    expect(stepFor(run, 'good')?.ok).toBe(true);
    expect(run.error).toContain('1 of 2');

    const note = await db.runtime.withTenant(actor, (t) =>
      t.note.findFirst({ where: { body: 'still ran' } }),
    );
    expect(note).not.toBeNull();
  }, 60_000);
});
