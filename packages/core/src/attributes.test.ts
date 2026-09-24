import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_TYPES,
  INDEXABLE_TYPES,
  coerceCell,
  filterOpsFor,
  indexColumnKind,
  parseAttributeConfig,
  validateRecordValues,
  type AttributeDef,
} from './attributes.ts';
import { detectDelimiter, parseCsv, toCsv } from './csv.ts';
import { needsRebalance, positionBetween, rebalancedPositions } from './fractional-index.ts';

const attr = (over: Partial<AttributeDef> & Pick<AttributeDef, 'id' | 'type'>): AttributeDef => ({
  apiSlug: over.id,
  title: over.id,
  config: {},
  isRequired: false,
  isUnique: false,
  isSystem: false,
  ...over,
});

const ATTRS: AttributeDef[] = [
  attr({ id: 'name', type: 'TEXT', isRequired: true }),
  attr({ id: 'email', type: 'EMAIL' }),
  attr({ id: 'amount', type: 'CURRENCY', config: { currency: 'EUR' } }),
  attr({
    id: 'stage',
    type: 'STATUS',
    config: {
      options: [
        { id: 'new', label: 'New' },
        { id: 'won', label: 'Won', category: 'won' },
      ],
    },
  }),
  attr({
    id: 'tags',
    type: 'MULTISELECT',
    config: {
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  }),
  attr({ id: 'closes', type: 'DATE' }),
  attr({ id: 'rating', type: 'RATING', config: { max: 5 } }),
  attr({ id: 'phone', type: 'PHONE' }),
  attr({ id: 'site', type: 'URL' }),
  attr({ id: 'active', type: 'BOOLEAN' }),
  attr({
    id: 'company',
    type: 'RELATIONSHIP',
    config: { targetObjectTypeId: '11111111-1111-4111-8111-111111111111', multiple: false },
  }),
  attr({ id: 'score', type: 'FORMULA', config: { expression: '1+1', outputType: 'NUMBER' } }),
];

describe('attribute types', () => {
  it('covers every type with a config schema, filter ops and an index kind decision', () => {
    for (const t of ATTRIBUTE_TYPES) {
      expect(
        parseAttributeConfig(
          t,
          t === 'RELATIONSHIP'
            ? { targetObjectTypeId: '11111111-1111-4111-8111-111111111111' }
            : t === 'ROLLUP'
              ? { relationAttributeId: '11111111-1111-4111-8111-111111111111' }
              : t === 'AI_RESEARCH'
                ? { prompt: 'x' }
                : t === 'FORMULA'
                  ? { expression: 'x' }
                  : t === 'SELECT' || t === 'STATUS' || t === 'MULTISELECT'
                    ? { options: [{ id: 'a', label: 'A' }] }
                    : {},
        ).ok,
        t,
      ).toBe(true);
      expect(filterOpsFor(t).length, t).toBeGreaterThan(0);
      expect(INDEXABLE_TYPES.has(t) === (indexColumnKind(t) !== null), t).toBe(true);
    }
  });

  it('validates a full create payload across twelve types', () => {
    const r = validateRecordValues(
      ATTRS,
      {
        name: 'Acme',
        email: 'Sales@ACME.com',
        amount: 1250.5,
        stage: 'new',
        tags: ['a', 'b'],
        closes: '2026-12-31',
        rating: 4,
        phone: '+14155552671',
        site: 'https://acme.example',
        active: true,
        company: ['22222222-2222-4222-8222-222222222222'],
      },
      'create',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.values['email']).toBe('sales@acme.com');
      expect(Object.keys(r.value.values)).toContain('company');
    }
  });

  it('reports every field error at once and enforces required on create', () => {
    const r = validateRecordValues(
      ATTRS,
      { email: 'nope', stage: 'missing', rating: 9, score: 3 },
      'create',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = (r.error.details['fields'] as { apiSlug: string; message: string }[]).map(
        (f) => f.apiSlug,
      );
      expect(fields.sort()).toEqual(['email', 'name', 'rating', 'score', 'stage']);
      expect(r.error.code).toBe('VALIDATION');
    }
  });

  it('update mode validates only present keys and refuses to clear a required one', () => {
    expect(validateRecordValues(ATTRS, { email: 'a@b.co' }, 'update').ok).toBe(true);
    expect(validateRecordValues(ATTRS, { name: null }, 'update').ok).toBe(false);
    expect(validateRecordValues(ATTRS, { bogus: 1 }, 'update').ok).toBe(false);
  });

  it('coerces CSV cells per type', () => {
    expect(coerceCell(ATTRS[2]!, '€1,250.50')).toEqual({ value: 1250.5 });
    expect(coerceCell(ATTRS[3]!, 'Won')).toEqual({ value: 'won' });
    expect(coerceCell(ATTRS[4]!, 'A; B')).toEqual({ value: ['a', 'b'] });
    expect(coerceCell(ATTRS[5]!, '31 Dec 2026')).toEqual({ value: '2026-12-31' });
    expect(coerceCell(ATTRS[9]!, 'yes')).toEqual({ value: true });
    expect(coerceCell(ATTRS[0]!, '   ')).toEqual({ empty: true });
    expect('error' in coerceCell(ATTRS[6]!, 'lots')).toBe(true);
  });
});

describe('csv', () => {
  it('parses quotes, escaped quotes, embedded newlines and CRLF', () => {
    const t = parseCsv('name,note\r\n"Acme, Inc","She said ""hi""\nthen left"\r\nBeta,plain\r\n');
    expect(t.headers).toEqual(['name', 'note']);
    expect(t.rows).toEqual([
      ['Acme, Inc', 'She said "hi"\nthen left'],
      ['Beta', 'plain'],
    ]);
  });
  it('round-trips through toCsv and detects delimiters', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['x,y', 'z'],
        [1, null],
      ],
    );
    expect(parseCsv(csv).rows).toEqual([
      ['x,y', 'z'],
      ['1', ''],
    ]);
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
  });
});

describe('fractional index', () => {
  it('places between neighbours and flags exhausted precision', () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1024, null)).toBe(2048);
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(needsRebalance(1, 1 + 1e-9)).toBe(true);
    expect(rebalancedPositions(3)).toEqual([1024, 2048, 3072]);
  });
});
