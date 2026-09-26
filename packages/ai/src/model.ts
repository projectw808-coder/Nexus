/**
 * The AI provider seam (ADR-021 decision 4) — the same shape as the connector SDK's `KeyProvider`
 * (ADR-014): one narrow interface, a deterministic test double, and thin `fetch`-based adapters
 * for the real providers. No vendor SDK is a dependency of this package, and nothing here reaches
 * the network unless a caller resolved a real adapter through `aiModelFromEnv`.
 */
import { NexusError } from '@nexus/core';

export type AiCompleteInput = { system: string; user: string; maxTokens?: number };
export type AiCompleteResult = { text: string; promptTokens: number; completionTokens: number };
export type AiEmbedResult = { vectors: number[][]; promptTokens: number };

export type AiModel = {
  /** e.g. 'mock', 'anthropic:claude-sonnet-4-5', 'openai:gpt-4o-mini', 'disabled'. */
  name: string;
  complete(input: AiCompleteInput): Promise<AiCompleteResult>;
  embed(texts: string[]): Promise<AiEmbedResult>;
};

/** Dimensionality every `Embedding.vector` / `Record.embedding` column is declared with. */
export const EMBEDDING_DIMENSIONS = 1536;

// ── the deterministic test double ────────────────────────────────────────────

export type MockAiModel = AiModel & { calls: { complete: number; embed: number } };

const UUID_IN_CONTEXT = /\bid:\s*([0-9a-fA-F-]{36})\b/g;
const TASK_MARKER = /^#\s*task:\s*([a-z_]+)$/m;

/** Every TimelineEvent id the prompt registry put into a context block, in order. */
export function contextIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(UUID_IN_CONTEXT)) if (m[1]) out.push(m[1]);
  return out;
}

function taskOf(system: string): string {
  return TASK_MARKER.exec(system)?.[1] ?? 'unknown';
}

/**
 * Canned, schema-shaped JSON per prompt task, so `generateStructured()`'s Zod validation has
 * something realistic to parse in tests that do not care what the model "said". Citations echo
 * real ids out of the prompt's own context block — plus one obviously invented id, so the
 * citation filter in `summary.ts` is exercised on the default path rather than only in the one
 * test that scripts a hallucination.
 */
function defaultCompletion(input: AiCompleteInput): string {
  const ids = contextIdsIn(input.user).slice(0, 3);
  const citations = [...ids, '00000000-0000-4000-8000-000000000000'];
  switch (taskOf(input.system)) {
    case 'conversation_summary':
      return JSON.stringify({
        summary: 'The customer asked about pricing and is waiting on a quote.',
        intent: 'sales',
        sentiment: 'neutral',
        urgency: 'medium',
        nextAction: 'Send the pricing sheet and offer a call this week.',
        confidence: 0.72,
        citations,
      });
    case 'relationship_brief':
      return JSON.stringify({
        summary: 'Recurring buyer, engaged across two channels, sensitive to response time.',
        caresAbout: ['pricing', 'delivery time'],
        openThreads: ['Quote request from the Instagram DM thread'],
        riskFlags: [],
        confidence: 0.64,
        citations,
      });
    case 'research_attribute':
      return JSON.stringify({
        value: 'Acme Industries',
        sources: [{ url: 'https://example.com/acme', title: 'Acme Industries' }],
        confidence: 0.55,
        citations: ids,
      });
    case 'reply_draft':
      return JSON.stringify({
        text: 'Thanks for reaching out — sending the pricing over now. Anything else I can help with?',
        citations,
      });
    default:
      return JSON.stringify({ text: 'ok', citations: ids });
  }
}

/** Stable pseudo-embedding: same text always yields the same unit-ish vector, no network. */
export function deterministicVector(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const out = new Array<number>(dims);
  let state = seed || 1;
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const v = state / 0xffffffff - 0.5;
    out[i] = v;
    norm += v * v;
  }
  const len = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) out[i] = (out[i] ?? 0) / len;
  return out;
}

export function mockAiModel(opts?: {
  complete?: (input: AiCompleteInput) => {
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  };
  embed?: (texts: string[]) => number[][];
}): MockAiModel {
  const calls = { complete: 0, embed: 0 };
  return {
    name: 'mock',
    calls,
    complete(input) {
      calls.complete += 1;
      const scripted = opts?.complete?.(input);
      const text = scripted?.text ?? defaultCompletion(input);
      return Promise.resolve({
        text,
        promptTokens:
          scripted?.promptTokens ?? Math.ceil((input.system.length + input.user.length) / 4),
        completionTokens: scripted?.completionTokens ?? Math.ceil(text.length / 4),
      });
    },
    embed(texts) {
      calls.embed += 1;
      const vectors = opts?.embed?.(texts) ?? texts.map((t) => deterministicVector(t));
      return Promise.resolve({
        vectors,
        promptTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
      });
    },
  };
}

/** The safe default: `AI_PROVIDER=disabled` can never spend budget or leak data. */
export function disabledModel(): AiModel {
  const blocked = (): never => {
    throw new NexusError('POLICY_BLOCKED', {
      message: 'AI is disabled for this deployment (AI_PROVIDER=disabled).',
      context: { reason: 'AI_PROVIDER is disabled.' },
    });
  };
  return {
    name: 'disabled',
    // `async` so callers get a rejected promise rather than a synchronous throw.
    complete: async () => blocked(),
    embed: async () => blocked(),
  };
}

// ── real adapters (thin; the mock is what the rest of the package is tested against) ──

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_MAX_TOKENS = 1024;

async function readError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const code =
      res.status === 429 ? 'RATE_LIMITED' : res.status === 401 ? 'AUTH_EXPIRED' : 'INTERNAL';
    throw new NexusError(code, {
      message: `${provider} returned ${res.status}`,
      details: { status: res.status, body: await readError(res) },
    });
  }
  return (await res.json()) as unknown;
}

function pickNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function anthropicModel(opts: {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
}): AiModel {
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: `anthropic:${model}`,
    async complete(input) {
      const json = (await postJson(
        fetchFn,
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        },
        'Anthropic',
      )) as {
        content?: { type?: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return {
        text,
        promptTokens: pickNumber(json.usage?.input_tokens),
        completionTokens: pickNumber(json.usage?.output_tokens),
      };
    },
    async embed(): Promise<never> {
      throw new NexusError('POLICY_BLOCKED', {
        message:
          'Anthropic has no embeddings endpoint; configure AI_PROVIDER=openai for semantic search.',
        context: { reason: 'The configured provider cannot produce embeddings.' },
      });
    },
  };
}

export function openaiModel(opts: {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  fetchFn?: typeof fetch;
}): AiModel {
  const model = opts.model ?? DEFAULT_OPENAI_MODEL;
  const embeddingModel = opts.embeddingModel ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  const fetchFn = opts.fetchFn ?? fetch;
  const auth = { authorization: `Bearer ${opts.apiKey}` };
  return {
    name: `openai:${model}`,
    async complete(input) {
      const json = (await postJson(
        fetchFn,
        'https://api.openai.com/v1/chat/completions',
        auth,
        {
          model,
          max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        },
        'OpenAI',
      )) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        promptTokens: pickNumber(json.usage?.prompt_tokens),
        completionTokens: pickNumber(json.usage?.completion_tokens),
      };
    },
    async embed(texts) {
      if (!texts.length) return { vectors: [], promptTokens: 0 };
      // text-embedding-3-small is natively 1536-dimensional: no padding or truncation needed.
      const json = (await postJson(
        fetchFn,
        'https://api.openai.com/v1/embeddings',
        auth,
        { model: embeddingModel, input: texts },
        'OpenAI',
      )) as { data?: { embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
      return {
        vectors: (json.data ?? []).map((d) => d.embedding ?? []),
        promptTokens: pickNumber(json.usage?.prompt_tokens),
      };
    },
  };
}

/**
 * Resolve the configured provider once, at wiring time. `apps/web` and `apps/worker` call this
 * with `loadEnv()`'s result and pass the model into `AiDeps`; nothing else in this package reads
 * the environment.
 */
export function aiModelFromEnv(env: { AI_PROVIDER: string; AI_API_KEY?: string }): AiModel {
  switch (env.AI_PROVIDER) {
    case 'anthropic':
      if (!env.AI_API_KEY) return disabledModel();
      return anthropicModel({ apiKey: env.AI_API_KEY });
    case 'openai':
      if (!env.AI_API_KEY) return disabledModel();
      return openaiModel({ apiKey: env.AI_API_KEY });
    case 'self_hosted':
      // BYO endpoint is wired by the deployment: until one is configured, refuse rather than
      // silently fall back to a hosted provider.
      return disabledModel();
    default:
      return disabledModel();
  }
}
