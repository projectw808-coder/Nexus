/**
 * The document is generated from the same Zod schemas the routes validate with, so these tests
 * are about the *contract* holding its shape: 3.1, every operation present, bearer auth
 * documented, Problem Details on every error, and the filter DSL arriving intact from
 * @nexus/core rather than restated here.
 */
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, REST_V1_SERVER_URL } from './registry.ts';
import { pageQuerySchema, problemSchema, recordQueryBodySchema } from './schemas.ts';

const doc = generateOpenApiDocument();

const EXPECTED_OPERATIONS: [string, string][] = [
  ['/v1/objects', 'get'],
  ['/v1/objects', 'post'],
  ['/v1/objects/{slug}/records', 'get'],
  ['/v1/objects/{slug}/records', 'post'],
  ['/v1/objects/{slug}/records/query', 'post'],
  ['/v1/objects/{slug}/records/{id}', 'get'],
  ['/v1/objects/{slug}/records/{id}', 'patch'],
  ['/v1/objects/{slug}/records/{id}', 'delete'],
  ['/v1/lists/{id}/entries', 'get'],
  ['/v1/lists/{id}/entries', 'post'],
  ['/v1/people/{id}/timeline', 'get'],
  ['/v1/conversations', 'get'],
  ['/v1/conversations/{id}/messages', 'get'],
  ['/v1/conversations/{id}/messages', 'post'],
  ['/v1/connections', 'get'],
  ['/v1/connections/{id}/health', 'get'],
  ['/v1/connections/{id}/sync', 'post'],
  ['/v1/connections/{id}/pause', 'post'],
  ['/v1/connections/{id}/resume', 'post'],
  ['/v1/connections/{id}/runs', 'get'],
  ['/v1/connections/{id}/runs/{runId}/replay', 'post'],
  ['/v1/search', 'get'],
];

describe('the REST v1 OpenAPI document', () => {
  it('is OpenAPI 3.1 served under /api', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers?.[0]?.url).toBe(REST_V1_SERVER_URL);
    expect(doc.info.title).toContain('Nexus');
  });

  it('declares every §11.2 operation (minus the outbound-webhook subscription)', () => {
    for (const [path, method] of EXPECTED_OPERATIONS) {
      const item = doc.paths?.[path] as Record<string, unknown> | undefined;
      expect(item, `${method.toUpperCase()} ${path} is missing`).toBeDefined();
      expect(item?.[method], `${method.toUpperCase()} ${path} is missing`).toBeDefined();
    }
    // The subscription endpoint belongs to the outbound-webhook work, not to this document.
    expect(doc.paths?.['/v1/webhooks/subscriptions']).toBeUndefined();
  });

  it('documents the bearer scheme and requires it on every operation', () => {
    expect(doc.components?.securitySchemes?.['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const [path, method] of EXPECTED_OPERATIONS) {
      const op = (doc.paths?.[path] as Record<string, { security?: unknown[] }>)[method]!;
      expect(op.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('answers every failure with application/problem+json (RFC 9457)', () => {
    for (const [path, method] of EXPECTED_OPERATIONS) {
      const op = (
        doc.paths?.[path] as Record<
          string,
          { responses: Record<string, { content?: Record<string, unknown> }> }
        >
      )[method]!;
      for (const [status, response] of Object.entries(op.responses)) {
        if (Number(status) < 400) continue;
        expect(Object.keys(response.content ?? {}), `${method} ${path} ${status}`).toEqual([
          'application/problem+json',
        ]);
      }
      // §11.2's minimum error set, on every operation.
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(['400', '401', '403', '429', '500']),
      );
    }
  });

  it('caps every list endpoint at 200 and defaults it to 50', () => {
    for (const path of ['/v1/objects', '/v1/connections', '/v1/objects/{slug}/records']) {
      const params = (doc.paths?.[path] as { get: { parameters: unknown[] } }).get.parameters;
      const limit = params.find(
        (p): p is { name: string; schema: { maximum: number; default: number } } =>
          typeof p === 'object' && p !== null && (p as { name?: string }).name === 'limit',
      );
      expect(limit?.schema.maximum, path).toBe(200);
      expect(limit?.schema.default, path).toBe(50);
    }
  });

  it('carries @nexus/core’s filter DSL through unchanged', () => {
    const recordQuery = doc.components?.schemas?.['RecordQuery'] as {
      properties: Record<string, { maxItems?: number; maximum?: number }>;
    };
    expect(Object.keys(recordQuery.properties).sort()).toEqual(
      ['cursor', 'filters', 'includeDeleted', 'limit', 'search', 'sort'].sort(),
    );
    expect(recordQuery.properties['filters']?.maxItems).toBe(20);
    expect(recordQuery.properties['limit']?.maximum).toBe(200);
    // The schema the document describes is the schema the route parses.
    expect(recordQueryBodySchema.parse({}).limit).toBe(50);
  });
});

describe('the shared request schemas', () => {
  it('coerces and bounds the page query the way the document promises', () => {
    expect(pageQuerySchema.parse({}).limit).toBe(50);
    expect(pageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(pageQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('validates a Problem Details body', () => {
    expect(
      problemSchema.safeParse({
        type: 'https://nexuscrm.dev/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: 'Nope.',
      }).success,
    ).toBe(true);
    expect(problemSchema.safeParse({ title: 'Not found', status: 404 }).success).toBe(false);
  });
});
