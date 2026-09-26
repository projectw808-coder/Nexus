/**
 * One test per action in the §14 vocabulary, so nothing in it is unexercised. Real Postgres for
 * everything that writes; injected mocks for the three side effects that leave the process
 * (`send_reply`, `send_email`, `call_webhook`) and the one that hands off to the AI layer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addEntry,
  createList,
  createRecord,
  loadAttributes,
  personAttributes,
  systemActorFor,
  type Actor,
} from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { runWorkflowForEvent } from './engine.ts';
import type { AutomationEvent, WorkflowAction } from './events.ts';
import { createAutomationRuntime, type AutomationRuntime } from './runtime.ts';
import type { RunStep, WorkflowRow } from './types.ts';

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let ownerId: string;
let listId: string;
let personTypeId: string;
let subjectId: string;

const STAGES = [
  { id: 'new', label: 'New' },
  { id: 'qualified', label: 'Qualified' },
];

type Harness = {
  rt: AutomationRuntime;
  enqueued: AutomationEvent[];
  replies: { conversationId: string; text: string }[];
  emails: { to: string; subject: string; body: string }[];
  webhooks: { url: string; body: unknown }[];
  aiJobs: { feature: string; payload: Record<string, unknown> }[];
  slept: number[];
};

function harness(overrides: Partial<AutomationRuntime> = {}): Harness {
  const enqueued: AutomationEvent[] = [];
  const replies: Harness['replies'] = [];
  const emails: Harness['emails'] = [];
  const webhooks: Harness['webhooks'] = [];
  const aiJobs: Harness['aiJobs'] = [];
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
      return { status: 'QUEUED', outboundActionId: 'ob-1' };
    },
    sendEmail: async (input) => {
      emails.push(input);
    },
    callWebhook: async (url, body) => {
      webhooks.push({ url, body });
      return { status: 200 };
    },
    enqueueAi: async ({ feature, payload }) => {
      aiJobs.push({ feature, payload });
    },
    ...overrides,
  });
  return { rt, enqueued, replies, emails, webhooks, aiJobs, slept };
}

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

async function workflowWith(
  actions: WorkflowAction[],
  over: { name?: string; enabled?: boolean } = {},
): Promise<WorkflowRow> {
  return db.runtime.withTenant(actor, (t) =>
    t.workflow.create({
      data: {
        workspaceId,
        name: over.name ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
        enabled: over.enabled ?? true,
        trigger: { type: 'record.updated' },
        conditions: {},
        actions: actions as unknown as object,
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

let clock = 0;
function event(over: Partial<AutomationEvent> = {}): AutomationEvent {
  clock += 1;
  return {
    workspaceId,
    type: 'record.updated',
    occurredAt: new Date(Date.UTC(2026, 8, 24, 0, 0, clock)).toISOString(),
    recordId: subjectId,
    payload: { n: clock },
    causation: { workflowIds: [] },
    ...over,
  };
}

const stepsOf = (run: { steps: unknown }) => (run.steps ?? []) as RunStep[];
const only = (run: { steps: unknown }) => stepsOf(run)[0]!;

beforeAll(async () => {
  db = await createTestDatabase();
  const owner = await db.prisma.user.create({
    data: { email: 'owner@actions.test', name: 'Owner' },
  });
  ownerId = owner.id;
  const ws = await db.tenancy.createWorkspace({
    name: 'Actions',
    slug: 'actions',
    ownerUserId: ownerId,
  });
  workspaceId = ws.id;
  actor = { ...systemActorFor(ws.id), userId: ownerId, actorType: 'USER' };

  await db.runtime.withTenant(actor, async (t) => {
    const pa = await personAttributes(t);
    personTypeId = pa.objectTypeId;
    const list = await createList(t, actor, {
      objectTypeId: personTypeId,
      name: 'Board',
      kind: 'PIPELINE',
      stages: STAGES,
    });
    listId = list.id;
  });

  const subject = await person({ name: 'Subject One', email: 'subject@actions.test' });
  subjectId = subject.id;
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('record actions', () => {
  it('update_record writes through @nexus/db and enqueues a follow-on event', async () => {
    const h = harness();
    const workflow = await workflowWith([
      { id: 'u1', type: 'update_record', recordId: 'trigger', values: { name: 'Renamed' } },
    ]);
    const run = await runWorkflowForEvent(h.rt, workflow, event());

    expect(run.status).toBe('SUCCEEDED');
    expect(only(run)).toMatchObject({ type: 'update_record', ok: true });

    const after = await db.runtime.withTenant(actor, async (t) => {
      const pa = await personAttributes(t);
      const row = await t.record.findFirstOrThrow({
        where: { id: subjectId },
        select: { values: true },
      });
      return (row.values as Record<string, unknown>)[pa.ids.name!];
    });
    expect(after).toBe('Renamed');

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      type: 'record.updated',
      recordId: subjectId,
      causation: { workflowIds: [workflow.id] },
    });
  }, 60_000);

  it('create_record resolves the object type by api slug', async () => {
    const h = harness();
    const workflow = await workflowWith([
      {
        id: 'c1',
        type: 'create_record',
        objectTypeApiSlug: 'person',
        values: { name: 'Created By Workflow', email: 'created@actions.test' },
      },
    ]);
    const run = await runWorkflowForEvent(h.rt, workflow, event());
    expect(run.status).toBe('SUCCEEDED');

    const output = only(run).output as { recordId: string };
    const created = await db.runtime.withTenant(actor, (t) =>
      t.record.findFirstOrThrow({ where: { id: output.recordId }, select: { objectTypeId: true } }),
    );
    expect(created.objectTypeId).toBe(personTypeId);
    expect(h.enqueued[0]).toMatchObject({ type: 'record.created', objectTypeApiSlug: 'person' });
  }, 60_000);

  it('create_record fails its step for an unknown object type', async () => {
    const h = harness();
    const workflow = await workflowWith([
      { id: 'c1', type: 'create_record', objectTypeApiSlug: 'unicorn', values: {} },
    ]);
    const run = await runWorkflowForEvent(h.rt, workflow, event());
    expect(run.status).toBe('FAILED');
    expect(only(run).error).toContain('no object type "unicorn"');
  }, 60_000);

  it('create_task stamps a due date from dueInHours', async () => {
    const h = harness({ now: () => new Date('2026-09-24T00:00:00.000Z') });
    const workflow = await workflowWith([
      {
        id: 't1',
        type: 'create_task',
        title: 'Follow up',
        assigneeId: ownerId,
        dueInHours: 24,
        recordId: 'trigger',
      },
    ]);
    const run = await runWorkflowForEvent(h.rt, workflow, event());
    expect(run.status).toBe('SUCCEEDED');

    const output = only(run).output as { taskId: string };
    const task = await db.runtime.withTenant(actor, (t) =>
      t.task.findFirstOrThrow({ where: { id: output.taskId } }),
    );
    expect(task.title).toBe('Follow up');
    expect(task.assigneeId).toBe(ownerId);
    expect(task.recordId).toBe(subjectId);
    expect(task.dueAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  }, 60_000);

  it('create_note files a note against the trigger record', async () => {
    const h = harness();
    const workflow = await workflowWith([
      { id: 'n1', type: 'create_note', text: 'Auto note', recordId: 'trigger' },
    ]);
    const run = await runWorkflowForEvent(h.rt, workflow, event());
    expect(run.status).toBe('SUCCEEDED');

    const note = await db.runtime.withTenant(actor, (t) =>
      t.note.findFirstOrThrow({ where: { body: 'Auto note' } }),
    );
    expect(note.recordId).toBe(subjectId);
  }, 60_000);
});

describe('list actions', () => {
  it('list_add, stage_move and list_remove walk one record through a pipeline', async () => {
    const h = harness();
    const traveller = await person({ name: 'Traveller', email: 'traveller@actions.test' });

    const addRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'l1', type: 'list_add', listId, recordId: 'trigger', stage: 'new' },
      ]),
      event({ recordId: traveller.id }),
    );
    expect(addRun.status).toBe('SUCCEEDED');
    const entryId = (only(addRun).output as { entryId: string }).entryId;

    const moveRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 's1', type: 'stage_move', listId, toStage: 'qualified' }]),
      event({ recordId: traveller.id }),
    );
    expect(moveRun.status).toBe('SUCCEEDED');
    expect(only(moveRun).output).toMatchObject({
      entryId,
      fromStage: 'new',
      toStage: 'qualified',
    });
    expect(h.enqueued.some((e) => e.type === 'list.stage_changed')).toBe(true);

    const removeRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 'r1', type: 'list_remove', listId, recordId: 'trigger' }]),
      event({ recordId: traveller.id }),
    );
    expect(removeRun.status).toBe('SUCCEEDED');
    expect(only(removeRun).output).toMatchObject({ removed: true, entryId });

    const entry = await db.runtime.withTenant(actor, (t) =>
      t.listEntry.findFirstOrThrow({ where: { id: entryId } }),
    );
    expect(entry.deletedAt).not.toBeNull();
  }, 60_000);

  it('list_add is a no-op when the record is already in the list', async () => {
    const already = await person({ name: 'Already', email: 'already@actions.test' });
    await db.runtime.withTenant(actor, (t) =>
      addEntry(t, actor, { listId, recordId: already.id, stage: 'new' }),
    );
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 'l1', type: 'list_add', listId, recordId: 'trigger' }]),
      event({ recordId: already.id }),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(only(run).output).toMatchObject({ alreadyPresent: true });
    expect(h.enqueued).toHaveLength(0);
  }, 60_000);

  it('list_remove reports honestly when the record was never in the list', async () => {
    const stranger = await person({ name: 'Stranger', email: 'stranger@actions.test' });
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 'r1', type: 'list_remove', listId, recordId: 'trigger' }]),
      event({ recordId: stranger.id }),
    );
    expect(only(run).output).toMatchObject({ removed: false });
  }, 60_000);
});

describe('assign', () => {
  it('assigns a fixed user and audits it', async () => {
    const connection = await db.runtime.withTenant(actor, (t) =>
      t.connection.create({
        data: {
          workspaceId,
          platform: 'INSTAGRAM',
          label: 'IG',
          accountExternalId: 'ig1',
          accountName: 'IG',
          apiVersion: 'v26.0',
          tokenRef: 'vault:x',
        },
        select: { id: true },
      }),
    );
    const conversation = await db.runtime.withTenant(actor, (t) =>
      t.conversation.create({
        data: {
          workspaceId,
          connectionId: connection.id,
          platform: 'INSTAGRAM',
          kind: 'DM',
          externalId: 'assign-1',
        },
        select: { id: true },
      }),
    );

    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'a1', type: 'assign', conversationId: 'trigger', mode: 'user', userId: ownerId },
      ]),
      event({ conversationId: conversation.id }),
    );
    expect(run.status).toBe('SUCCEEDED');

    const after = await db.runtime.withTenant(actor, async (t) => ({
      conversation: await t.conversation.findFirstOrThrow({ where: { id: conversation.id } }),
      audit: await t.auditLog.findFirst({
        where: { action: 'conversation.assigned', targetId: conversation.id },
      }),
    }));
    expect(after.conversation.assigneeId).toBe(ownerId);
    expect(after.audit?.actorType).toBe('WORKFLOW');
  }, 60_000);

  it('fails the step when the event carries no conversation', async () => {
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'a1', type: 'assign', conversationId: 'trigger', mode: 'user', userId: ownerId },
      ]),
      event(),
    );
    expect(run.status).toBe('FAILED');
    expect(only(run).error).toContain('no conversation to assign');
  }, 60_000);
});

describe('injected side effects', () => {
  it('send_reply goes through the injected callback', async () => {
    const connection = await db.runtime.withTenant(actor, (t) =>
      t.connection.create({
        data: {
          workspaceId,
          platform: 'INSTAGRAM',
          label: 'IG2',
          accountExternalId: 'ig2',
          accountName: 'IG2',
          apiVersion: 'v26.0',
          tokenRef: 'vault:x',
        },
        select: { id: true },
      }),
    );
    const conversation = await db.runtime.withTenant(actor, (t) =>
      t.conversation.create({
        data: {
          workspaceId,
          connectionId: connection.id,
          platform: 'INSTAGRAM',
          kind: 'DM',
          externalId: 'reply-1',
        },
        select: { id: true },
      }),
    );

    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'sr1', type: 'send_reply', conversationId: 'trigger', text: 'Thanks!' },
      ]),
      event({ conversationId: conversation.id }),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(h.replies).toEqual([{ conversationId: conversation.id, text: 'Thanks!' }]);
    expect(only(run).output).toMatchObject({ status: 'QUEUED', outboundActionId: 'ob-1' });
  }, 60_000);

  it('send_reply fails that one step when no callback was injected', async () => {
    const h = harness({ sendReply: undefined });
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'sr1', type: 'send_reply', conversationId: 'fixed-id', text: 'Hi' },
        { id: 'n1', type: 'create_note', text: 'still reached', recordId: 'trigger' },
      ]),
      event(),
    );
    expect(run.status).toBe('FAILED');
    expect(stepsOf(run)[0]?.error).toContain('no sendReply callback');
    expect(stepsOf(run)[1]?.ok).toBe(true);
  }, 60_000);

  it('send_email goes through the injected callback', async () => {
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'e1', type: 'send_email', to: 'ops@acme.test', subject: 'Lead', body: 'A new lead.' },
      ]),
      event(),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(h.emails).toEqual([{ to: 'ops@acme.test', subject: 'Lead', body: 'A new lead.' }]);
  }, 60_000);

  it('call_webhook posts through the injected callback and fails on a non-2xx', async () => {
    const ok = harness();
    const okRun = await runWorkflowForEvent(
      ok.rt,
      await workflowWith([
        { id: 'w1', type: 'call_webhook', url: 'https://hooks.acme.test/lead', body: { hi: 1 } },
      ]),
      event(),
    );
    expect(okRun.status).toBe('SUCCEEDED');
    expect(ok.webhooks).toEqual([{ url: 'https://hooks.acme.test/lead', body: { hi: 1 } }]);

    const bad = harness({ callWebhook: async () => ({ status: 503 }) });
    const badRun = await runWorkflowForEvent(
      bad.rt,
      await workflowWith([{ id: 'w1', type: 'call_webhook', url: 'https://hooks.acme.test/lead' }]),
      event(),
    );
    expect(badRun.status).toBe('FAILED');
    expect(only(badRun).error).toContain('returned 503');
  }, 60_000);

  it('enqueue_ai hands off to the injected AI queue', async () => {
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'ai1', type: 'enqueue_ai', feature: 'summary', payload: { recordId: subjectId } },
      ]),
      event(),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(h.aiJobs).toEqual([{ feature: 'summary', payload: { recordId: subjectId } }]);

    const none = harness({ enqueueAi: undefined });
    const noneRun = await runWorkflowForEvent(
      none.rt,
      await workflowWith([{ id: 'ai1', type: 'enqueue_ai', feature: 'summary', payload: {} }]),
      event(),
    );
    expect(only(noneRun).error).toContain('no enqueueAi callback');
  }, 60_000);
});

describe('control flow', () => {
  it('wait delays through the injected sleep and records a resumeAt', async () => {
    const h = harness({ now: () => new Date('2026-09-24T00:00:00.000Z') });
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 'w1', type: 'wait', seconds: 90 }]),
      event(),
    );
    expect(run.status).toBe('SUCCEEDED');
    expect(h.slept).toEqual([90_000]);
    expect(only(run).output).toEqual({ seconds: 90, resumeAt: '2026-09-24T00:01:30.000Z' });
  }, 60_000);

  it('branch takes `then` or `else` and reports both the branch and its body as steps', async () => {
    const actions: WorkflowAction[] = [
      {
        id: 'b1',
        type: 'branch',
        condition: { leaf: { path: 'event.payload.tier', op: 'eq', value: 'gold' } },
        then: [{ id: 'gold', type: 'create_note', text: 'gold path', recordId: 'trigger' }],
        else: [{ id: 'other', type: 'create_note', text: 'other path', recordId: 'trigger' }],
      },
    ];
    const h = harness();

    const goldRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith(actions),
      event({ payload: { tier: 'gold' } }),
    );
    expect(stepsOf(goldRun).map((s) => s.actionId)).toEqual(['b1', 'gold']);
    expect(stepsOf(goldRun)[0]?.output).toMatchObject({ taken: 'then', actions: 1 });

    const otherRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith(actions),
      event({ payload: { tier: 'bronze' } }),
    );
    expect(stepsOf(otherRun).map((s) => s.actionId)).toEqual(['b1', 'other']);
    expect(stepsOf(otherRun)[0]?.output).toMatchObject({ taken: 'else' });

    const notes = await db.runtime.withTenant(actor, (t) =>
      t.note.findMany({ where: { body: { in: ['gold path', 'other path'] } } }),
    );
    expect(notes).toHaveLength(2);
  }, 60_000);

  it('branch with no else records the branch and runs nothing', async () => {
    const h = harness();
    const run = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        {
          id: 'b1',
          type: 'branch',
          condition: { leaf: { path: 'event.payload.tier', op: 'eq', value: 'gold' } },
          then: [{ id: 'gold', type: 'create_note', text: 'never', recordId: 'trigger' }],
        },
      ]),
      event({ payload: { tier: 'bronze' } }),
    );
    expect(stepsOf(run).map((s) => s.actionId)).toEqual(['b1']);
    expect(run.status).toBe('SUCCEEDED');
  }, 60_000);

  it('run_workflow executes a second workflow and reports its run', async () => {
    const child = await workflowWith(
      [{ id: 'cn', type: 'create_note', text: 'from child', recordId: 'trigger' }],
      { name: 'child' },
    );
    const parent = await workflowWith([{ id: 'rw', type: 'run_workflow', workflowId: child.id }], {
      name: 'parent',
    });

    const h = harness();
    const run = await runWorkflowForEvent(h.rt, parent, event());
    expect(run.status).toBe('SUCCEEDED');

    const output = only(run).output as { runId: string; status: string };
    expect(output.status).toBe('SUCCEEDED');

    const childRun = await db.runtime.withTenant(actor, (t) =>
      t.workflowRun.findFirstOrThrow({ where: { id: output.runId } }),
    );
    expect(childRun.workflowId).toBe(child.id);
    const note = await db.runtime.withTenant(actor, (t) =>
      t.note.findFirst({ where: { body: 'from child' } }),
    );
    expect(note).not.toBeNull();
  }, 60_000);

  describe('a cross-workflow cycle A → B → A', () => {
    let a: WorkflowRow;
    let b: WorkflowRow;

    beforeAll(async () => {
      b = await workflowWith([], { name: 'cycle-b' });
      a = await workflowWith([{ id: 'toB', type: 'run_workflow', workflowId: b.id }], {
        name: 'cycle-a',
      });
      await db.runtime.withTenant(actor, (t) =>
        t.workflow.update({
          where: { id: b.id },
          data: { actions: [{ id: 'toA', type: 'run_workflow', workflowId: a.id }] },
        }),
      );
      b = { ...b, actions: [{ id: 'toA', type: 'run_workflow', workflowId: a.id }] };
    }, 60_000);

    it('is stopped by idempotency: re-entering A for the same event returns the run in flight', async () => {
      const h = harness();
      const run = await runWorkflowForEvent(h.rt, a, event());
      const bOutput = only(run).output as { runId: string };
      const bRun = await db.runtime.withTenant(actor, (t) =>
        t.workflowRun.findFirstOrThrow({ where: { id: bOutput.runId } }),
      );
      const aAgain = ((bRun.steps ?? []) as RunStep[])[0]?.output as { runId: string };

      // Same event ⇒ same triggerKey ⇒ the (workflowId, triggerKey) unique index hands back the
      // outer run of A rather than starting a second one. The cycle terminates here.
      expect(aAgain.runId).toBe(run.id);
      const aRuns = await db.runtime.withTenant(actor, (t) =>
        t.workflowRun.count({ where: { workflowId: a.id } }),
      );
      expect(aRuns).toBe(1);
    }, 60_000);

    it('is stopped by the causation chain when the event differs', async () => {
      const h = harness();
      // Enter at B with A already in the chain, as a follow-on event would: B appends itself, so
      // A sees [A, B] and halts before any action runs.
      const bRun = await runWorkflowForEvent(
        h.rt,
        b,
        event({ causation: { workflowIds: [a.id] } }),
      );
      const aAgain = ((bRun.steps ?? []) as RunStep[])[0]?.output as {
        status: string;
        error: string | null;
      };
      expect(aAgain.status).toBe('CANCELLED');
      expect(aAgain.error).toBe('loop_detected');
    }, 60_000);
  });

  it('run_workflow fails its step for a disabled or missing target', async () => {
    const disabled = await workflowWith([], { name: 'disabled child', enabled: false });
    const h = harness();

    const disabledRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith([{ id: 'rw', type: 'run_workflow', workflowId: disabled.id }]),
      event(),
    );
    expect(only(disabledRun).error).toContain('is disabled');

    const missingRun = await runWorkflowForEvent(
      h.rt,
      await workflowWith([
        { id: 'rw', type: 'run_workflow', workflowId: '00000000-0000-4000-8000-00000000dead' },
      ]),
      event(),
    );
    expect(only(missingRun).error).toContain('not found');
  }, 60_000);
});

describe('conditions against record values', () => {
  it('loads the record only when the conditions mention record.*', async () => {
    const vip = await person({ name: 'VIP Person', email: 'vip@actions.test' });
    const workflow = await db.runtime.withTenant(actor, (t) =>
      t.workflow.create({
        data: {
          workspaceId,
          name: 'vip only',
          enabled: true,
          trigger: { type: 'record.updated' },
          conditions: { leaf: { path: 'record.email', op: 'contains', value: 'vip@' } },
          actions: [
            { id: 'n1', type: 'create_note', text: 'vip touched', recordId: 'trigger' },
          ] as unknown as object,
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

    const h = harness();
    const hit = await runWorkflowForEvent(h.rt, workflow, event({ recordId: vip.id }));
    expect(stepsOf(hit)).toHaveLength(1);

    const miss = await runWorkflowForEvent(h.rt, workflow, event({ recordId: subjectId }));
    expect(stepsOf(miss)).toHaveLength(0);
    expect(miss.status).toBe('SUCCEEDED');
  }, 60_000);
});
