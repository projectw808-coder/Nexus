import { describe, expect, it } from 'vitest';
import {
  conditionSchema,
  conditionsMatch,
  evaluateCondition,
  getByPath,
  isEmptyValue,
  parseConditions,
  type ConditionNode,
  type ConditionOp,
} from './conditions.ts';

const ctx = {
  event: {
    type: 'comment.received',
    platform: 'INSTAGRAM',
    occurredAt: '2026-09-20T10:00:00.000Z',
    payload: {
      body: 'What is the PRICE of this?',
      direction: 'inbound',
      likes: 12,
      tags: ['sales', 'urgent'],
      empty: '',
      emptyList: [],
      nothing: null,
    },
  },
  record: { email: 'dana@wholesale.test', score: 42, name: '' },
};

const leaf = (path: string, op: ConditionOp, value?: unknown): ConditionNode => ({
  leaf: value === undefined ? { path, op } : { path, op, value },
});

const check = (path: string, op: ConditionOp, value?: unknown): boolean =>
  evaluateCondition(leaf(path, op, value), ctx);

describe('getByPath', () => {
  it('walks nested objects', () => {
    expect(getByPath(ctx, 'event.payload.likes')).toBe(12);
    expect(getByPath(ctx, 'record.email')).toBe('dana@wholesale.test');
  });

  it('indexes into arrays', () => {
    expect(getByPath(ctx, 'event.payload.tags.0')).toBe('sales');
  });

  it('returns undefined for a missing or non-object step, never throwing', () => {
    expect(getByPath(ctx, 'event.nope')).toBeUndefined();
    expect(getByPath(ctx, 'event.payload.likes.deeper')).toBeUndefined();
    expect(getByPath(ctx, 'record.email.length.more')).toBeUndefined();
    expect(getByPath(null, 'a.b')).toBeUndefined();
    expect(getByPath(ctx, '')).toBeUndefined();
  });
});

describe('isEmptyValue', () => {
  it.each([
    [null, true],
    [undefined, true],
    ['', true],
    [[], true],
    ['x', false],
    [0, false],
    [false, false],
    [[0], false],
    [{}, false],
  ])('%s → %s', (value, expected) => {
    expect(isEmptyValue(value)).toBe(expected);
  });
});

describe('leaf operators', () => {
  it('eq / neq compare primitives and structures', () => {
    expect(check('event.payload.likes', 'eq', 12)).toBe(true);
    expect(check('event.payload.likes', 'eq', '12')).toBe(false);
    expect(check('event.payload.likes', 'neq', 13)).toBe(true);
    expect(check('event.payload.tags', 'eq', ['sales', 'urgent'])).toBe(true);
    expect(check('event.payload.tags', 'eq', ['urgent', 'sales'])).toBe(false);
    expect(check('event.payload.nothing', 'eq', null)).toBe(true);
  });

  it('contains is a case-insensitive substring match on two strings', () => {
    expect(check('event.payload.body', 'contains', 'price')).toBe(true);
    expect(check('event.payload.body', 'contains', 'PRICE')).toBe(true);
    expect(check('event.payload.body', 'contains', 'refund')).toBe(false);
  });

  it('contains is false when either side is not a string', () => {
    expect(check('event.payload.likes', 'contains', '1')).toBe(false);
    expect(check('event.payload.tags', 'contains', 'sales')).toBe(false);
    expect(check('event.payload.body', 'contains', 3)).toBe(false);
  });

  it('in / notIn need an array value', () => {
    expect(check('event.platform', 'in', ['INSTAGRAM', 'FACEBOOK'])).toBe(true);
    expect(check('event.platform', 'in', ['X'])).toBe(false);
    expect(check('event.platform', 'notIn', ['X'])).toBe(true);
    expect(check('event.platform', 'notIn', ['INSTAGRAM'])).toBe(false);
    expect(check('event.platform', 'in', 'INSTAGRAM')).toBe(false);
    expect(check('event.platform', 'notIn', 'INSTAGRAM')).toBe(false);
  });

  it('compares numbers', () => {
    expect(check('record.score', 'gt', 40)).toBe(true);
    expect(check('record.score', 'gte', 42)).toBe(true);
    expect(check('record.score', 'lt', 42)).toBe(false);
    expect(check('record.score', 'lte', 42)).toBe(true);
  });

  it('compares ISO date strings as dates', () => {
    expect(check('event.occurredAt', 'gt', '2026-09-19T00:00:00.000Z')).toBe(true);
    expect(check('event.occurredAt', 'lt', '2026-09-21')).toBe(true);
    expect(check('event.occurredAt', 'gte', '2026-09-20T10:00:00.000Z')).toBe(true);
  });

  it('refuses to compare things that are neither numbers nor dates', () => {
    expect(check('event.payload.body', 'gt', 'a')).toBe(false);
    expect(check('event.payload.tags', 'lt', 5)).toBe(false);
    expect(check('record.score', 'gt', 'not a number')).toBe(false);
  });

  it('isEmpty / isNotEmpty', () => {
    expect(check('event.payload.empty', 'isEmpty')).toBe(true);
    expect(check('event.payload.emptyList', 'isEmpty')).toBe(true);
    expect(check('event.payload.nothing', 'isEmpty')).toBe(true);
    expect(check('record.name', 'isEmpty')).toBe(true);
    expect(check('event.payload.body', 'isNotEmpty')).toBe(true);
    expect(check('event.payload.likes', 'isNotEmpty')).toBe(true);
    expect(check('event.payload.empty', 'isNotEmpty')).toBe(false);
  });
});

describe('a missing path', () => {
  const ops: ConditionOp[] = [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'in',
    'notIn',
    'isNotEmpty',
  ];

  it('satisfies isEmpty', () => {
    expect(check('event.payload.absent', 'isEmpty')).toBe(true);
    expect(check('totally.made.up.path', 'isEmpty')).toBe(true);
  });

  it.each(ops)('is false for %s, and never throws', (op) => {
    expect(check('event.payload.absent', op, 'anything')).toBe(false);
    expect(check('event.payload.absent', op, ['anything'])).toBe(false);
  });

  it('does not make `neq` accidentally true', () => {
    expect(check('nope.nope', 'neq', 'x')).toBe(false);
  });
});

describe('and / or / not nesting', () => {
  it('and requires every child', () => {
    expect(
      evaluateCondition(
        { and: [leaf('event.payload.body', 'contains', 'price'), leaf('record.score', 'gt', 10)] },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { and: [leaf('event.payload.body', 'contains', 'price'), leaf('record.score', 'gt', 99)] },
        ctx,
      ),
    ).toBe(false);
  });

  it('or needs one', () => {
    expect(
      evaluateCondition(
        { or: [leaf('record.score', 'gt', 99), leaf('event.platform', 'eq', 'INSTAGRAM')] },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { or: [leaf('record.score', 'gt', 99), leaf('event.platform', 'eq', 'X')] },
        ctx,
      ),
    ).toBe(false);
  });

  it('an empty and is true and an empty or is false', () => {
    expect(evaluateCondition({ and: [] }, ctx)).toBe(true);
    expect(evaluateCondition({ or: [] }, ctx)).toBe(false);
  });

  it('not inverts', () => {
    expect(evaluateCondition({ not: leaf('event.platform', 'eq', 'X') }, ctx)).toBe(true);
    expect(evaluateCondition({ not: leaf('event.platform', 'eq', 'INSTAGRAM') }, ctx)).toBe(false);
  });

  it('nests three levels deep', () => {
    const tree: ConditionNode = {
      and: [
        { or: [leaf('event.platform', 'eq', 'X'), leaf('event.platform', 'eq', 'INSTAGRAM')] },
        { not: { and: [leaf('event.payload.direction', 'eq', 'outbound')] } },
        leaf('event.payload.body', 'contains', 'price'),
      ],
    };
    expect(evaluateCondition(tree, ctx)).toBe(true);
  });
});

describe('conditionSchema', () => {
  it('accepts a recursive tree', () => {
    const tree = {
      and: [
        { leaf: { path: 'a.b', op: 'eq', value: 1 } },
        { or: [{ not: { leaf: { path: 'c', op: 'isEmpty' } } }] },
      ],
    };
    expect(() => conditionSchema.parse(tree)).not.toThrow();
  });

  it('rejects an unknown operator and an empty path', () => {
    expect(() => conditionSchema.parse({ leaf: { path: 'a', op: 'matches' } })).toThrow();
    expect(() => conditionSchema.parse({ leaf: { path: '', op: 'eq' } })).toThrow();
    expect(() => conditionSchema.parse({ nope: [] })).toThrow();
  });
});

describe('parseConditions / conditionsMatch', () => {
  it('treats null, {} and [] as "no conditions"', () => {
    expect(parseConditions(null)).toBeNull();
    expect(parseConditions(undefined)).toBeNull();
    expect(parseConditions({})).toBeNull();
    expect(parseConditions([])).toBeNull();
    expect(conditionsMatch([], ctx)).toBe(true);
    expect(conditionsMatch({}, ctx)).toBe(true);
  });

  it('treats a non-empty array as an implicit and', () => {
    expect(
      conditionsMatch(
        [
          leaf('event.platform', 'eq', 'INSTAGRAM'),
          leaf('event.payload.body', 'contains', 'price'),
        ],
        ctx,
      ),
    ).toBe(true);
    expect(
      conditionsMatch(
        [
          leaf('event.platform', 'eq', 'INSTAGRAM'),
          leaf('event.payload.body', 'contains', 'refund'),
        ],
        ctx,
      ),
    ).toBe(false);
  });

  it('parses a stored single node', () => {
    expect(
      conditionsMatch({ leaf: { path: 'event.platform', op: 'eq', value: 'INSTAGRAM' } }, ctx),
    ).toBe(true);
  });
});
