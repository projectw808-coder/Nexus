/** generateStructured: happy path, one corrective retry, and the two-failures hard stop. */
import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { z } from 'zod';
import { mockAiModel } from './model.ts';
import { extractJson, generateStructured } from './structured.ts';

const schema = z.object({ answer: z.string(), score: z.number() });

describe('extractJson', () => {
  it('unwraps a fenced block and surrounding prose', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nhope that helps')).toBe('{"a":1}');
    expect(extractJson('here you go: {"a":1} done')).toBe('{"a":1}');
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe('generateStructured', () => {
  it('parses and validates a good first answer', async () => {
    const model = mockAiModel({
      complete: () => ({
        text: '{"answer":"yes","score":3}',
        promptTokens: 10,
        completionTokens: 4,
      }),
    });
    const out = await generateStructured(model, {
      promptVersion: 'v1',
      system: 's',
      user: 'u',
      schema,
    });
    expect(out.data).toEqual({ answer: 'yes', score: 3 });
    expect(out.model).toBe('mock');
    expect(out.promptVersion).toBe('v1');
    expect(out.promptTokens).toBe(10);
    expect(out.completionTokens).toBe(4);
    expect(model.calls.complete).toBe(1);
  });

  it('retries once with the validation error and accumulates tokens', async () => {
    let attempt = 0;
    const seen: string[] = [];
    const model = mockAiModel({
      complete: (input) => {
        attempt += 1;
        seen.push(input.user);
        return attempt === 1
          ? { text: 'I think the answer is yes.', promptTokens: 10, completionTokens: 5 }
          : { text: '{"answer":"yes","score":3}', promptTokens: 20, completionTokens: 6 };
      },
    });
    const out = await generateStructured(model, {
      promptVersion: 'v1',
      system: 's',
      user: 'u',
      schema,
    });
    expect(out.data).toEqual({ answer: 'yes', score: 3 });
    expect(model.calls.complete).toBe(2);
    expect(out.promptTokens).toBe(30);
    expect(out.completionTokens).toBe(11);
    expect(seen[1]).toContain('Validation error:');
    expect(seen[1]).toContain('corrected JSON');
  });

  it('throws INTERNAL after two failures, without a third attempt', async () => {
    const model = mockAiModel({ complete: () => ({ text: '{"answer":"yes"}' }) });
    await expect(
      generateStructured(model, { promptVersion: 'v1', system: 's', user: 'u', schema }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(model.calls.complete).toBe(2);
  });

  it('carries both problems in details', async () => {
    const model = mockAiModel({ complete: () => ({ text: 'not json at all' }) });
    const error = await generateStructured(model, {
      promptVersion: 'v2',
      system: 's',
      user: 'u',
      schema,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NexusError);
    const details = (error as NexusError).details;
    expect(details['promptVersion']).toBe('v2');
    expect(String(details['firstProblem'])).toContain('not valid JSON');
    expect(String(details['secondProblem'])).toContain('not valid JSON');
  });
});
