import { describe, expect, it } from 'vitest';
import {
  TRIGGER_TYPES,
  automationEventSchema,
  parseActions,
  parseTrigger,
  triggerKeyFor,
  triggerMatches,
  workflowActionSchema,
  workflowTriggerSchema,
  type AutomationEvent,
  type WorkflowAction,
} from './events.ts';

const base: AutomationEvent = {
  workspaceId: 'ws-1',
  type: 'comment.received',
  occurredAt: '2026-09-24T09:00:00.000Z',
  platform: 'INSTAGRAM',
  connectionId: 'conn-1',
  recordId: 'rec-1',
  conversationId: 'conv-1',
  payload: { body: 'price?', direction: 'inbound' },
  causation: { workflowIds: [] },
};

describe('automationEventSchema', () => {
  it('accepts a minimal envelope and round-trips a full one', () => {
    expect(() =>
      automationEventSchema.parse({
        workspaceId: 'ws-1',
        type: 'schedule',
        occurredAt: '2026-09-24T09:00:00.000Z',
        payload: {},
        causation: { workflowIds: [] },
      }),
    ).not.toThrow();
    expect(automationEventSchema.parse(base)).toMatchObject({ type: 'comment.received' });
  });

  it('rejects an unknown trigger type and a missing causation chain', () => {
    expect(() => automationEventSchema.parse({ ...base, type: 'nope' })).toThrow();
    const { causation: _causation, ...withoutChain } = base;
    expect(() => automationEventSchema.parse(withoutChain)).toThrow();
  });
});

describe('triggerKeyFor', () => {
  it('is stable for the same event and ignores the causation chain', () => {
    const key = triggerKeyFor(base);
    expect(triggerKeyFor({ ...base })).toBe(key);
    expect(triggerKeyFor({ ...base, causation: { workflowIds: ['a', 'b'] } })).toBe(key);
    // Key order in the payload must not matter.
    expect(triggerKeyFor({ ...base, payload: { direction: 'inbound', body: 'price?' } })).toBe(key);
  });

  it('differs for a different event', () => {
    const key = triggerKeyFor(base);
    expect(triggerKeyFor({ ...base, conversationId: 'conv-2' })).not.toBe(key);
    expect(triggerKeyFor({ ...base, occurredAt: '2026-09-24T09:00:01.000Z' })).not.toBe(key);
    expect(triggerKeyFor({ ...base, payload: { body: 'other' } })).not.toBe(key);
  });
});

describe('triggerMatches', () => {
  it('requires the type to agree', () => {
    expect(triggerMatches({ type: 'comment.received' }, base)).toBe(true);
    expect(triggerMatches({ type: 'message.received' }, base)).toBe(false);
  });

  it('compares platform case-insensitively and only when specified', () => {
    expect(triggerMatches({ type: 'comment.received', platform: 'instagram' }, base)).toBe(true);
    expect(triggerMatches({ type: 'comment.received', platform: 'FACEBOOK' }, base)).toBe(false);
    expect(triggerMatches({ type: 'comment.received' }, { ...base, platform: null })).toBe(true);
    expect(
      triggerMatches({ type: 'comment.received', platform: 'X' }, { ...base, platform: null }),
    ).toBe(false);
  });

  it('narrows on object type and list', () => {
    const recordEvent: AutomationEvent = {
      ...base,
      type: 'record.created',
      objectTypeApiSlug: 'person',
    };
    expect(
      triggerMatches({ type: 'record.created', objectTypeApiSlug: 'person' }, recordEvent),
    ).toBe(true);
    expect(triggerMatches({ type: 'record.created', objectTypeApiSlug: 'deal' }, recordEvent)).toBe(
      false,
    );

    const listEvent: AutomationEvent = { ...base, type: 'list.entry_added', listId: 'list-1' };
    expect(triggerMatches({ type: 'list.entry_added', listId: 'list-1' }, listEvent)).toBe(true);
    expect(triggerMatches({ type: 'list.entry_added', listId: 'list-2' }, listEvent)).toBe(false);
  });
});

describe('workflowTriggerSchema', () => {
  it('covers every trigger in the §14 vocabulary', () => {
    expect(TRIGGER_TYPES).toHaveLength(13);
    for (const type of TRIGGER_TYPES) {
      expect(() => workflowTriggerSchema.parse({ type })).not.toThrow();
    }
  });

  it('carries cron without interpreting it', () => {
    expect(parseTrigger({ type: 'schedule', cron: '0 9 * * 1' }).cron).toBe('0 9 * * 1');
  });

  it('rejects a non-uuid listId', () => {
    expect(() =>
      workflowTriggerSchema.parse({ type: 'list.entry_added', listId: 'nope' }),
    ).toThrow();
  });
});

describe('workflowActionSchema', () => {
  it('accepts both assign modes', () => {
    expect(() =>
      workflowActionSchema.parse({ id: 'a', type: 'assign', mode: 'user', userId: 'u1' }),
    ).not.toThrow();
    expect(() =>
      workflowActionSchema.parse({
        id: 'a',
        type: 'assign',
        mode: 'round_robin',
        candidateUserIds: ['u1', 'u2'],
      }),
    ).not.toThrow();
    expect(() =>
      workflowActionSchema.parse({
        id: 'a',
        type: 'assign',
        mode: 'round_robin',
        candidateUserIds: [],
      }),
    ).toThrow();
  });

  it('recurses through branch bodies', () => {
    const nested: WorkflowAction = {
      id: 'b1',
      type: 'branch',
      condition: { leaf: { path: 'event.payload.tier', op: 'eq', value: 'gold' } },
      then: [
        {
          id: 'b2',
          type: 'branch',
          condition: { not: { leaf: { path: 'event.payload.x', op: 'isEmpty' } } },
          then: [{ id: 'n1', type: 'create_note', text: 'deep' }],
        },
      ],
      else: [{ id: 'w1', type: 'wait', seconds: 5 }],
    };
    expect(() => workflowActionSchema.parse(nested)).not.toThrow();
  });

  it('rejects a malformed action and requires an id', () => {
    expect(() => workflowActionSchema.parse({ type: 'wait', seconds: 1 })).toThrow();
    expect(() => workflowActionSchema.parse({ id: 'a', type: 'teleport' })).toThrow();
    expect(() =>
      workflowActionSchema.parse({ id: 'a', type: 'call_webhook', url: 'not a url' }),
    ).toThrow();
  });

  it('parseActions reads null and a non-array as an empty list', () => {
    expect(parseActions(null)).toEqual([]);
    expect(parseActions({})).toEqual([]);
    expect(parseActions([{ id: 'w1', type: 'wait', seconds: 1 }])).toHaveLength(1);
  });
});
