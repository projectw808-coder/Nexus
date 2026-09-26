/**
 * Strict JSON output (spec §13 engineering rules): every model call goes through here, so every
 * output is parsed, Zod-validated and stamped with the prompt version that produced it. One
 * corrective retry, then a hard failure — a feature never silently degrades to prose.
 */
import { NexusError } from '@nexus/core';
import type { ZodType } from 'zod';
import type { AiModel } from './model.ts';

export type StructuredResult<T> = {
  data: T;
  promptTokens: number;
  completionTokens: number;
  model: string;
  promptVersion: string;
};

/** Models like to wrap JSON in prose or a ```json fence. Pull the outermost object back out. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (body.startsWith('{') || body.startsWith('[')) return body;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  return first >= 0 && last > first ? body.slice(first, last + 1) : body;
}

function problemWith<T>(
  schema: ZodType<T>,
  text: string,
): { ok: true; data: T } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, problem: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = schema.safeParse(parsed);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    problem: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  };
}

export async function generateStructured<T>(
  model: AiModel,
  opts: {
    promptVersion: string;
    system: string;
    user: string;
    schema: ZodType<T>;
    maxTokens?: number;
  },
): Promise<StructuredResult<T>> {
  let promptTokens = 0;
  let completionTokens = 0;

  const first = await model.complete({
    system: opts.system,
    user: opts.user,
    ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
  });
  promptTokens += first.promptTokens;
  completionTokens += first.completionTokens;

  const attempt1 = problemWith(opts.schema, first.text);
  if (attempt1.ok) {
    return {
      data: attempt1.data,
      promptTokens,
      completionTokens,
      model: model.name,
      promptVersion: opts.promptVersion,
    };
  }

  const retryUser = [
    opts.user,
    '',
    '---',
    'Your previous reply could not be used. It was:',
    first.text.slice(0, 2000),
    '',
    `Validation error: ${attempt1.problem}`,
    'Reply again with ONLY the corrected JSON object. No prose, no markdown fence, no commentary.',
  ].join('\n');

  const second = await model.complete({
    system: opts.system,
    user: retryUser,
    ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
  });
  promptTokens += second.promptTokens;
  completionTokens += second.completionTokens;

  const attempt2 = problemWith(opts.schema, second.text);
  if (attempt2.ok) {
    return {
      data: attempt2.data,
      promptTokens,
      completionTokens,
      model: model.name,
      promptVersion: opts.promptVersion,
    };
  }

  throw new NexusError('INTERNAL', {
    message: 'model did not return valid structured output',
    details: {
      model: model.name,
      promptVersion: opts.promptVersion,
      firstProblem: attempt1.problem,
      secondProblem: attempt2.problem,
      promptTokens,
      completionTokens,
    },
  });
}
