/**
 * The Phase 11 acceptance criterion (§16), proved literally: **the OpenAPI spec generates a
 * working client.**
 *
 * The test fetches the served `/api/v1/openapi.json`, runs `openapi-typescript` over exactly
 * those bytes, writes the result to disk, and writes a small client module beside it that
 * imports the *generated* `paths` type into `openapi-fetch`'s `createClient`. That module is
 * then:
 *
 *   1. type-checked with a real `tsc --noEmit` — including a `@ts-expect-error` that only holds
 *      if the generated types actually enforce the document's required request body, so a
 *      vacuous "it compiled" cannot pass; and
 *   2. imported and executed against the real route handlers over a real database, creating and
 *      reading back a record through the generated path templates.
 *
 * Nothing here is hand-written against the API: every path string, parameter and response type
 * the client uses came out of the document the server produced.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REST_BASE_URL, restHarness, type RestHarness } from './rest-testing';
import { seedWorkspaces, type Seed } from './testing';

/** Dot-prefixed so TypeScript's own `**\/*.ts` include never picks up the generated sources. */
const OUT_DIR = path.resolve(import.meta.dirname, '../.openapi-generated');
const DOCUMENT_FILE = path.join(OUT_DIR, 'openapi.json');
const SCHEMA_FILE = path.join(OUT_DIR, 'schema.ts');
const CLIENT_FILE = path.join(OUT_DIR, 'client.ts');
const TSCONFIG_FILE = path.join(OUT_DIR, 'tsconfig.json');

const GENERATED_CLIENT_SOURCE = `/**
 * Written by apps/web/server/openapi-client.test.ts. Every type below comes from ./schema.ts,
 * which openapi-typescript produced from the document the server served.
 */
import createClient from 'openapi-fetch';
import type { paths } from './schema.ts';

export type Fetcher = (input: Request) => Promise<Response>;

export async function run(opts: { baseUrl: string; fetch: Fetcher; token: string }) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    headers: { Authorization: \`Bearer \${opts.token}\` },
  });

  const objects = await client.GET('/v1/objects', { params: { query: { limit: 50 } } });
  // \`slugs\` is string[] only because the document types ObjectType.apiSlug as a string.
  const slugs: string[] = (objects.data?.items ?? []).map((o) => o.apiSlug);

  const created = await client.POST('/v1/objects/{slug}/records', {
    params: { path: { slug: 'person' } },
    body: { values: { name: 'Generated Client', email: 'generated@example.test' } },
  });
  const createdId: string | undefined = created.data?.id;
  const createdLabel: string | undefined = created.data?.label;

  const fetched = createdId
    ? await client.GET('/v1/objects/{slug}/records/{id}', {
        params: { path: { slug: 'person', id: createdId } },
      })
    : null;

  const queried = await client.POST('/v1/objects/{slug}/records/query', {
    params: { path: { slug: 'person' } },
    body: {
      filters: [{ attribute: 'name', op: 'eq', value: 'Generated Client' }],
      sort: [],
      limit: 10,
      includeDeleted: false,
    },
  });

  const unauthorized = await client.GET('/v1/objects', {
    headers: { Authorization: 'Bearer nx_live_00000000000000000000000000000000' },
  });

  // The document marks the create body required; the generated types must say so too.
  await client.POST('/v1/objects/{slug}/records', {
    params: { path: { slug: 'person' } },
    // @ts-expect-error - \`values\` is a required property of the generated request body type.
    body: {},
  });

  return {
    slugs,
    createdId,
    createdLabel,
    createStatus: created.response.status,
    fetchedLabel: fetched?.data?.label,
    fetchedStatus: fetched?.response.status,
    queriedLabels: (queried.data?.items ?? []).map((r) => r.label),
    unauthorizedStatus: unauthorized.response.status,
    unauthorizedProblem: unauthorized.error?.code,
  };
}
`;

const TSCONFIG_SOURCE = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2023', 'DOM'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      types: [],
    },
    include: ['schema.ts', 'client.ts'],
  },
  null,
  2,
);

let seed: Seed;
let rest: RestHarness;
let document: Record<string, unknown>;

beforeAll(async () => {
  seed = await seedWorkspaces();
  rest = restHarness(seed);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // (a) Fetch the document the server actually serves — not the in-process generator.
  const res = await rest.fetch(`${REST_BASE_URL}/v1/openapi.json`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  document = (await res.json()) as Record<string, unknown>;

  // (b) Generate a typed client from it, with openapi-typescript's own CLI over those bytes.
  writeFileSync(DOCUMENT_FILE, JSON.stringify(document, null, 2), 'utf8');
  const generated = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../node_modules/openapi-typescript/bin/cli.js'),
      DOCUMENT_FILE,
      '--output',
      SCHEMA_FILE,
    ],
    { encoding: 'utf8', cwd: OUT_DIR },
  );
  if (generated.status !== 0) {
    throw new Error(
      `openapi-typescript failed: ${generated.stderr ?? ''}${generated.stdout ?? ''}`,
    );
  }
  writeFileSync(CLIENT_FILE, GENERATED_CLIENT_SOURCE, 'utf8');
  writeFileSync(TSCONFIG_FILE, `${TSCONFIG_SOURCE}\n`, 'utf8');
}, 300_000);

afterAll(async () => {
  rest?.dispose();
  await seed?.db.close();
  rmSync(OUT_DIR, { recursive: true, force: true });
});

describe('the served OpenAPI document', () => {
  it('is a complete 3.1 document covering every REST v1 operation', () => {
    expect(document['openapi']).toBe('3.1.0');
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).sort()).toEqual(
      [
        '/v1/connections',
        '/v1/connections/{id}/health',
        '/v1/connections/{id}/pause',
        '/v1/connections/{id}/resume',
        '/v1/connections/{id}/runs',
        '/v1/connections/{id}/runs/{runId}/replay',
        '/v1/connections/{id}/sync',
        '/v1/conversations',
        '/v1/conversations/{id}/messages',
        '/v1/lists/{id}/entries',
        '/v1/objects',
        '/v1/objects/{slug}/records',
        '/v1/objects/{slug}/records/query',
        '/v1/objects/{slug}/records/{id}',
        '/v1/people/{id}/timeline',
        '/v1/search',
      ].sort(),
    );
    const components = document['components'] as { securitySchemes: Record<string, unknown> };
    expect(components.securitySchemes['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    // Every error is Problem Details, so the type has to be in the document.
    const records = paths['/v1/objects/{slug}/records'] as {
      get: { responses: Record<string, { content: Record<string, unknown> }> };
    };
    expect(Object.keys(records.get.responses['401']!.content)).toEqual([
      'application/problem+json',
    ]);
  });
});

describe('a client generated from that document', () => {
  it('type-checks against the document, including its required request bodies', () => {
    const tsc = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../node_modules/typescript/lib/tsc.js'),
        '--noEmit',
        '-p',
        TSCONFIG_FILE,
      ],
      { encoding: 'utf8', cwd: OUT_DIR },
    );
    expect(`${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim()).toBe('');
    expect(tsc.status).toBe(0);
  }, 300_000);

  it('makes real authenticated calls and gets correctly typed responses back', async () => {
    const key = await rest.createKey({ name: 'generated client', scopes: ['WRITE'] });
    const mod = (await import(pathToFileURL(CLIENT_FILE).href)) as {
      run(opts: {
        baseUrl: string;
        fetch: (input: Request) => Promise<Response>;
        token: string;
      }): Promise<{
        slugs: string[];
        createdId?: string;
        createdLabel?: string;
        createStatus: number;
        fetchedLabel?: string;
        fetchedStatus?: number;
        queriedLabels: string[];
        unauthorizedStatus: number;
        unauthorizedProblem?: string;
      }>;
    };

    const result = await mod.run({
      baseUrl: REST_BASE_URL,
      fetch: (input) => rest.fetch(input),
      token: key.plaintext,
    });

    expect(result.slugs).toEqual(expect.arrayContaining(['person', 'company', 'deal']));
    expect(result.createStatus).toBe(201);
    expect(result.createdId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.createdLabel).toBe('Generated Client');
    expect(result.fetchedStatus).toBe(200);
    expect(result.fetchedLabel).toBe('Generated Client');
    expect(result.queriedLabels).toContain('Generated Client');
    // The generated client also models the error side: a bad key is a typed Problem Details body.
    expect(result.unauthorizedStatus).toBe(401);
    expect(result.unauthorizedProblem).toBe('AUTH_EXPIRED');
  }, 300_000);
});
