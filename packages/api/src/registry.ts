/**
 * The REST v1 OpenAPI 3.1 registry (spec §11.2, ADR-022 decision 2).
 *
 * Paths here are written as the spec writes them — `/v1/objects/{slug}/records` — and the
 * document declares `servers: [{ url: '/api' }]`, so a generated client pointed at
 * `https://host/api` resolves exactly the App Router handlers under
 * `apps/web/app/api/v1/**`. The registry knows nothing about routing or auth beyond the bearer
 * scheme it documents; that is the whole scope boundary of this package.
 *
 * Deviation from the spec's literal path, documented deliberately: the filter-DSL endpoint is
 * `POST /v1/objects/{slug}/records/query`, not `records:query`. A colon cannot appear in a
 * directory name on Windows (and the App Router is file-based), so the colon form is
 * unimplementable here. Record ids are UUIDs, so the static `query` segment can never shadow a
 * real record.
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import {
  attributeSchema,
  conversationListQuerySchema,
  conversationPageSchema,
  connectionHealthSchema,
  connectionPageSchema,
  connectionStatusSchema,
  createListEntrySchema,
  createMessageSchema,
  createObjectTypeSchema,
  deletedSchema,
  enqueuedSchema,
  filterSchema,
  listEntryPageSchema,
  messagePageSchema,
  objectTypePageSchema,
  objectTypeSchema,
  pageQuerySchema,
  pauseRequestSchema,
  problemSchema,
  recordPageSchema,
  recordQueryBodySchema,
  recordSchema,
  recordValuesSchema,
  replayRequestSchema,
  replayResultSchema,
  replyOutcomeSchema,
  searchQuerySchema,
  searchResultSchema,
  sortSchema,
  syncRequestSchema,
  syncRunPageSchema,
  timelinePageSchema,
  timelineQuerySchema,
  connectionSchema,
  conversationSchema,
  listEntrySchema,
  messageSchema,
  syncRunSchema,
  timelineEventSchema,
} from './schemas.ts';
import { z } from './zod-openapi.ts';

export const REST_V1_VERSION = '1.0.0';
/** Mounted under Next's `/api`, so a client's baseUrl is `<origin>/api`. */
export const REST_V1_SERVER_URL = '/api';

const BEARER = 'bearerAuth';

const slugParam = z.object({
  slug: z.string().openapi({
    param: {
      name: 'slug',
      in: 'path',
      description: 'The **object type**’s `apiSlug` (e.g. `person`) — never the workspace slug.',
    },
    example: 'person',
  }),
});
const idParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});
const slugIdParam = z.object({
  slug: z.string().openapi({ param: { name: 'slug', in: 'path' }, example: 'person' }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});
const runParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
  runId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'runId', in: 'path' } }),
});

type Registry = OpenAPIRegistry;

function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

function problem(description: string) {
  return { description, content: { 'application/problem+json': { schema: problemSchema } } };
}

/** The error responses every authenticated route can produce. */
function commonErrors(extra: Record<string, ReturnType<typeof problem>> = {}) {
  return {
    400: problem('Malformed request or failed validation (RFC 9457).'),
    401: problem('Missing, malformed, unknown, revoked or expired API key.'),
    403: problem('The key’s scopes do not cover this operation.'),
    429: problem('Per-key rate limit exceeded; see `X-RateLimit-Reset`.'),
    500: problem('Unexpected server error.'),
    ...extra,
  };
}

const NOT_FOUND = { 404: problem('No such resource in this workspace.') };
const CONFLICT = {
  409: problem('An `Idempotency-Key` was reused with a different request, or a state conflict.'),
};

function buildRegistry(): Registry {
  const r = new OpenAPIRegistry();

  r.registerComponent('securitySchemes', BEARER, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Nexus workspace API key',
    description:
      'A workspace API key: `Authorization: Bearer nx_live_…`. The key fixes the workspace, ' +
      'which is why no workspace appears in any path. Scopes form a ladder — `WRITE` implies ' +
      '`READ`, `ADMIN` implies both.',
  });

  // Reusable component schemas (so the generated client gets named types, not inline blobs).
  r.register('Problem', problemSchema);
  r.register('ObjectType', objectTypeSchema);
  r.register('Attribute', attributeSchema);
  r.register('Record', recordSchema);
  r.register('Filter', filterSchema);
  r.register('Sort', sortSchema);
  r.register('RecordQuery', recordQueryBodySchema);
  r.register('ListEntry', listEntrySchema);
  r.register('TimelineEvent', timelineEventSchema);
  r.register('Conversation', conversationSchema);
  r.register('Message', messageSchema);
  r.register('ReplyOutcome', replyOutcomeSchema);
  r.register('Connection', connectionSchema);
  r.register('ConnectionHealth', connectionHealthSchema);
  r.register('SyncRun', syncRunSchema);

  const idempotency = z
    .string()
    .min(8)
    .max(200)
    .optional()
    .openapi({
      param: {
        name: 'Idempotency-Key',
        in: 'header',
        description:
          'Replays the stored response instead of re-running the handler. The same key with a ' +
          'different method, path or body is a 409.',
      },
    });

  // ── objects ───────────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/objects',
    tags: ['Objects'],
    summary: 'List object types',
    security: [{ [BEARER]: [] }],
    request: { query: pageQuerySchema },
    responses: { 200: json(objectTypePageSchema, 'A page of object types.'), ...commonErrors() },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/objects',
    tags: ['Objects'],
    summary: 'Create an object type',
    security: [{ [BEARER]: [] }],
    request: {
      headers: [idempotency],
      body: { content: { 'application/json': { schema: createObjectTypeSchema } }, required: true },
    },
    responses: {
      201: json(objectTypeSchema, 'The created object type.'),
      ...commonErrors(CONFLICT),
    },
  });

  // ── records ───────────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/objects/{slug}/records',
    tags: ['Records'],
    summary: 'List records of one object type',
    security: [{ [BEARER]: [] }],
    request: {
      params: slugParam,
      query: pageQuerySchema.extend({
        search: z.string().max(200).optional(),
        includeDeleted: z.coerce.boolean().optional(),
      }),
    },
    responses: {
      200: json(recordPageSchema, 'A cursor-paginated page of records.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/objects/{slug}/records',
    tags: ['Records'],
    summary: 'Create a record',
    security: [{ [BEARER]: [] }],
    request: {
      params: slugParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: recordValuesSchema } }, required: true },
    },
    responses: {
      201: json(recordSchema, 'The created record.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/objects/{slug}/records/query',
    tags: ['Records'],
    summary: 'Query records with the filter DSL',
    description:
      'The spec writes this as `records:query`; a colon is not a legal path segment in the ' +
      'App Router’s file-based routing, so the operation lives at `records/query`. The body is ' +
      '`RecordQuery` — the same object the internal query layer takes.',
    security: [{ [BEARER]: [] }],
    request: {
      params: slugParam,
      body: { content: { 'application/json': { schema: recordQueryBodySchema } }, required: true },
    },
    responses: {
      200: json(recordPageSchema, 'A cursor-paginated page of matching records.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'get',
    path: '/v1/objects/{slug}/records/{id}',
    tags: ['Records'],
    summary: 'Fetch one record',
    security: [{ [BEARER]: [] }],
    request: { params: slugIdParam },
    responses: { 200: json(recordSchema, 'The record.'), ...commonErrors(NOT_FOUND) },
  });
  r.registerPath({
    method: 'patch',
    path: '/v1/objects/{slug}/records/{id}',
    tags: ['Records'],
    summary: 'Update a record',
    description: 'A `null` value clears that attribute; omitted attributes are left alone.',
    security: [{ [BEARER]: [] }],
    request: {
      params: slugIdParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: recordValuesSchema } }, required: true },
    },
    responses: {
      200: json(recordSchema, 'The updated record.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });
  r.registerPath({
    method: 'delete',
    path: '/v1/objects/{slug}/records/{id}',
    tags: ['Records'],
    summary: 'Soft-delete a record',
    security: [{ [BEARER]: [] }],
    request: { params: slugIdParam, headers: [idempotency] },
    responses: {
      200: json(deletedSchema, 'The record was soft-deleted.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });

  // ── list entries ──────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/lists/{id}/entries',
    tags: ['Lists'],
    summary: 'List the entries of a list or pipeline',
    security: [{ [BEARER]: [] }],
    request: { params: idParam, query: pageQuerySchema.extend({ stage: z.string().optional() }) },
    responses: {
      200: json(listEntryPageSchema, 'A cursor-paginated page of entries.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/lists/{id}/entries',
    tags: ['Lists'],
    summary: 'Add a record to a list',
    security: [{ [BEARER]: [] }],
    request: {
      params: idParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: createListEntrySchema } }, required: true },
    },
    responses: {
      201: json(listEntrySchema, 'The created entry.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });

  // ── timeline ──────────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/people/{id}/timeline',
    tags: ['Timeline'],
    summary: 'The unified timeline of one person',
    description:
      'Events attached to the person **and** to any of their channel identities, unioned ' +
      '(§6.3) — an unresolved identity’s history is never lost and never doubled.',
    security: [{ [BEARER]: [] }],
    request: { params: idParam, query: timelineQuerySchema },
    responses: {
      200: json(timelinePageSchema, 'A cursor-paginated page of events, with facet counts.'),
      ...commonErrors(NOT_FOUND),
    },
  });

  // ── conversations ─────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/conversations',
    tags: ['Conversations'],
    summary: 'List conversations',
    security: [{ [BEARER]: [] }],
    request: { query: conversationListQuerySchema },
    responses: {
      200: json(conversationPageSchema, 'A cursor-paginated page of conversations.'),
      ...commonErrors(),
    },
  });
  r.registerPath({
    method: 'get',
    path: '/v1/conversations/{id}/messages',
    tags: ['Conversations'],
    summary: 'List the messages of a conversation',
    security: [{ [BEARER]: [] }],
    request: { params: idParam, query: pageQuerySchema },
    responses: {
      200: json(messagePageSchema, 'A cursor-paginated page of messages, oldest first.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/conversations/{id}/messages',
    tags: ['Conversations'],
    summary: 'Send a reply',
    description:
      'Goes through the same `preflight` → `OutboundAction` flow as the in-app composer. A ' +
      'platform policy block is a 200 with `status: "blocked"`, not an error.',
    security: [{ [BEARER]: [] }],
    request: {
      params: idParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: createMessageSchema } }, required: true },
    },
    responses: {
      202: json(replyOutcomeSchema, 'The reply was accepted, deduplicated or blocked.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });

  // ── connections ───────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/connections',
    tags: ['Connections'],
    summary: 'List connections',
    description: 'Token handles and webhook-secret handles are never returned (§5.4).',
    security: [{ [BEARER]: [] }],
    request: { query: pageQuerySchema },
    responses: {
      200: json(connectionPageSchema, 'A cursor-paginated page of connections.'),
      ...commonErrors(),
    },
  });
  r.registerPath({
    method: 'get',
    path: '/v1/connections/{id}/health',
    tags: ['Connections'],
    summary: 'One connection’s health',
    security: [{ [BEARER]: [] }],
    request: { params: idParam },
    responses: {
      200: json(connectionHealthSchema, 'Quota, webhooks, failed runs, drift and token expiry.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/connections/{id}/sync',
    tags: ['Connections'],
    summary: 'Sync now',
    security: [{ [BEARER]: [] }],
    request: {
      params: idParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: syncRequestSchema } }, required: false },
    },
    responses: {
      202: json(enqueuedSchema, 'The sync jobs were enqueued.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/connections/{id}/pause',
    tags: ['Connections'],
    summary: 'Pause a connection',
    security: [{ [BEARER]: [] }],
    request: {
      params: idParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: pauseRequestSchema } }, required: false },
    },
    responses: {
      200: json(connectionStatusSchema, 'The connection is paused.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/connections/{id}/resume',
    tags: ['Connections'],
    summary: 'Resume a connection',
    security: [{ [BEARER]: [] }],
    request: { params: idParam, headers: [idempotency] },
    responses: {
      200: json(connectionStatusSchema, 'The connection is connected again.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });
  r.registerPath({
    method: 'get',
    path: '/v1/connections/{id}/runs',
    tags: ['Connections'],
    summary: 'List sync runs',
    security: [{ [BEARER]: [] }],
    request: { params: idParam, query: pageQuerySchema },
    responses: {
      200: json(syncRunPageSchema, 'A cursor-paginated page of runs, newest first.'),
      ...commonErrors(NOT_FOUND),
    },
  });
  r.registerPath({
    method: 'post',
    path: '/v1/connections/{id}/runs/{runId}/replay',
    tags: ['Connections'],
    summary: 'Replay a sync run',
    description:
      'Re-runs the pipeline over the raw objects that run committed. The raw store is never ' +
      'touched, which is the point of committing raw before interpretation (§4.1).',
    security: [{ [BEARER]: [] }],
    request: {
      params: runParam,
      headers: [idempotency],
      body: { content: { 'application/json': { schema: replayRequestSchema } }, required: false },
    },
    responses: {
      202: json(replayResultSchema, 'The replay jobs were enqueued.'),
      ...commonErrors({ ...NOT_FOUND, ...CONFLICT }),
    },
  });

  // ── search ────────────────────────────────────────────────────────────────
  r.registerPath({
    method: 'get',
    path: '/v1/search',
    tags: ['Search'],
    summary: 'Cross-object search',
    security: [{ [BEARER]: [] }],
    request: { query: searchQuerySchema },
    responses: {
      200: json(searchResultSchema, 'Matches grouped by object type.'),
      ...commonErrors(),
    },
  });

  return r;
}

/** `GET /api/v1/openapi.json` serves exactly this. */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/** The complete OpenAPI 3.1 document. */
export function generateOpenApiDocument(): OpenApiDocument {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Nexus CRM REST v1',
      version: REST_V1_VERSION,
      description:
        'The public REST API. Authenticate with a workspace API key ' +
        '(`Authorization: Bearer nx_live_…`); the key fixes the workspace, so no path contains ' +
        'one. Every list endpoint is cursor-paginated (`?cursor=&limit=`, max 200); every ' +
        'write accepts an `Idempotency-Key`; every response carries `X-RateLimit-*`; every ' +
        'error is RFC 9457 Problem Details (`application/problem+json`).',
    },
    servers: [{ url: REST_V1_SERVER_URL, description: 'This deployment.' }],
    tags: [
      { name: 'Objects', description: 'Object types — the schema of the CRM.' },
      { name: 'Records', description: 'Records of any object type, including the system ones.' },
      { name: 'Lists', description: 'Pipelines and collections.' },
      { name: 'Timeline', description: 'The unified per-person activity stream.' },
      { name: 'Conversations', description: 'The unified inbox and outbound replies.' },
      { name: 'Connections', description: 'Connected platform accounts and their sync runs.' },
      { name: 'Search', description: 'Cross-object search.' },
    ],
  });
}
