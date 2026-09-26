/**
 * The provider seam. The mock is what the rest of the package is tested against; the real
 * adapters get "the request shape is right" coverage against a fake fetch — never the network.
 */
import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  aiModelFromEnv,
  anthropicModel,
  deterministicVector,
  disabledModel,
  mockAiModel,
  openaiModel,
} from './model.ts';

type Captured = { url: string; init: RequestInit };

function fakeFetch(body: unknown, captured: Captured[]): typeof fetch {
  return ((url: string, init: RequestInit) => {
    captured.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

function failingFetch(status: number): typeof fetch {
  return () => Promise.resolve(new Response('nope', { status }));
}

/** The adapters always send a JSON string body; narrow it for assertions. */
function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

describe('mockAiModel', () => {
  it('counts calls and echoes deterministic vectors', async () => {
    const model = mockAiModel();
    const a = await model.embed(['hello']);
    const b = await model.embed(['hello']);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(a.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(model.calls.embed).toBe(2);
    expect(model.calls.complete).toBe(0);
  });

  it('defaults to schema-shaped JSON keyed off the prompt task marker', async () => {
    const model = mockAiModel();
    const out = await model.complete({
      system: '# task: conversation_summary\nyou are an analyst',
      user: '- id: 11111111-1111-4111-8111-111111111111 | body',
    });
    const parsed = JSON.parse(out.text) as { intent: string; citations: string[] };
    expect(parsed.intent).toBe('sales');
    expect(parsed.citations).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('honours a script', async () => {
    const model = mockAiModel({ complete: () => ({ text: 'scripted' }) });
    expect((await model.complete({ system: '', user: '' })).text).toBe('scripted');
  });
});

describe('deterministicVector', () => {
  it('is stable, unit length and differs per input', () => {
    const a = deterministicVector('acme industries');
    const b = deterministicVector('acme industries');
    const c = deterministicVector('something else entirely');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const norm = Math.sqrt(a.reduce((n, v) => n + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe('disabledModel', () => {
  it('blocks both operations with POLICY_BLOCKED and no network', async () => {
    const model = disabledModel();
    await expect(model.complete({ system: '', user: '' })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    await expect(model.embed(['x'])).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });
});

describe('anthropicModel', () => {
  it('POSTs the Messages API with x-api-key and anthropic-version', async () => {
    const captured: Captured[] = [];
    const model = anthropicModel({
      apiKey: 'sk-test',
      model: 'claude-test',
      fetchFn: fakeFetch(
        {
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
        captured,
      ),
    });
    const out = await model.complete({ system: 'sys', user: 'usr', maxTokens: 64 });
    expect(out).toEqual({ text: '{"ok":true}', promptTokens: 11, completionTokens: 7 });
    expect(model.name).toBe('anthropic:claude-test');

    const call = captured[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = bodyOf(call.init);
    expect(body).toMatchObject({
      model: 'claude-test',
      max_tokens: 64,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
    });
  });

  it('refuses to embed and says where to go instead', async () => {
    const model = anthropicModel({ apiKey: 'sk-test' });
    await expect(model.embed(['x'])).rejects.toThrow(/AI_PROVIDER=openai/);
  });

  it('maps HTTP failures onto the taxonomy', async () => {
    const model = anthropicModel({ apiKey: 'k', fetchFn: failingFetch(429) });
    await expect(model.complete({ system: '', user: '' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const unauthorized = anthropicModel({ apiKey: 'k', fetchFn: failingFetch(401) });
    await expect(unauthorized.complete({ system: '', user: '' })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
  });
});

describe('openaiModel', () => {
  it('POSTs chat completions with a Bearer token', async () => {
    const captured: Captured[] = [];
    const model = openaiModel({
      apiKey: 'sk-oai',
      model: 'gpt-test',
      fetchFn: fakeFetch(
        {
          choices: [{ message: { content: '{"ok":1}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        captured,
      ),
    });
    const out = await model.complete({ system: 'sys', user: 'usr' });
    expect(out.text).toBe('{"ok":1}');
    expect(out.promptTokens).toBe(5);

    const call = captured[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-oai');
    const body = bodyOf(call.init) as { messages: { role: string }[] };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('POSTs the embeddings endpoint and returns the vectors', async () => {
    const captured: Captured[] = [];
    const model = openaiModel({
      apiKey: 'sk-oai',
      fetchFn: fakeFetch(
        { data: [{ embedding: [1, 2, 3] }], usage: { prompt_tokens: 4 } },
        captured,
      ),
    });
    const out = await model.embed(['hello']);
    expect(out.vectors).toEqual([[1, 2, 3]]);
    expect(out.promptTokens).toBe(4);
    expect(captured[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    const body = bodyOf(captured[0]!.init);
    expect(body['model']).toBe('text-embedding-3-small');
    expect(body['input']).toEqual(['hello']);
  });

  it('short-circuits an empty embed batch', async () => {
    const model = openaiModel({ apiKey: 'k', fetchFn: failingFetch(500) });
    expect(await model.embed([])).toEqual({ vectors: [], promptTokens: 0 });
  });
});

describe('aiModelFromEnv', () => {
  it('resolves each provider, and falls back to disabled without a key', () => {
    expect(aiModelFromEnv({ AI_PROVIDER: 'disabled' }).name).toBe('disabled');
    expect(aiModelFromEnv({ AI_PROVIDER: 'self_hosted', AI_API_KEY: 'k' }).name).toBe('disabled');
    expect(aiModelFromEnv({ AI_PROVIDER: 'anthropic' }).name).toBe('disabled');
    expect(aiModelFromEnv({ AI_PROVIDER: 'openai' }).name).toBe('disabled');
    expect(aiModelFromEnv({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }).name).toMatch(
      /^anthropic:/,
    );
    expect(aiModelFromEnv({ AI_PROVIDER: 'openai', AI_API_KEY: 'k' }).name).toMatch(/^openai:/);
  });
});
