/**
 * The Zod schemas REST v1 validates with — and therefore the schemas its OpenAPI 3.1 document
 * is generated from (ADR-022 decision 2: one source, so the contract and the validation can
 * never drift). Shapes that already exist in @nexus/core are reused, not restated:
 * `recordQuerySchema`/`filterSchema`/`sortSchema` are literally the filter DSL behind
 * `POST /v1/objects/{slug}/records/query`.
 */
import { z } from './zod-openapi.ts';
import {
  filterSchema as coreFilterSchema,
  recordQuerySchema as coreRecordQuerySchema,
  sortSchema as coreSortSchema,
} from '@nexus/core';

/**
 * Re-home a schema that was built before `.openapi()` was patched onto Zod's prototype.
 *
 * Zod 4 copies `ZodType.prototype`'s members onto each instance *at construction time*, so a
 * schema constructed while @nexus/core was first imported (which, in a Next.js process, is long
 * before @nexus/api loads) has no `.openapi()` of its own and cannot be handed to
 * `registry.register()`. Rebuilding the object from its own `shape` produces an identical schema
 * constructed *now* — same fields, same defaults, same validation — that the registry accepts.
 * This is a re-wrap of the canonical shape, never a restatement of it.
 */
function reHome<T extends z.ZodObject>(schema: T): T {
  return z.object(schema.shape) as unknown as T;
}

// ── primitives ──────────────────────────────────────────────────────────────

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const jsonValue: z.ZodType<unknown> = z.unknown();
const jsonObject = z.record(z.string(), jsonValue);

/** `?cursor=&limit=` on every list endpoint (§11.2). `limit` is capped at 200 everywhere. */
export const pageQuerySchema = z.object({
  cursor: z
    .string()
    .max(512)
    .optional()
    .openapi({
      param: { description: 'Opaque cursor from a previous response’s `nextCursor`.' },
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .openapi({ param: { description: `1–${MAX_PAGE_LIMIT}; defaults to ${DEFAULT_PAGE_LIMIT}.` } }),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** RFC 9457 Problem Details. Every non-2xx response in REST v1 has this body. */
export const problemSchema = z
  .object({
    type: z.string().describe('A URI identifying the problem type.'),
    title: z.string().describe('A short, human-readable summary of the problem type.'),
    status: z.number().int().describe('The HTTP status code.'),
    detail: z.string().describe('A human-readable explanation specific to this occurrence.'),
    code: z
      .string()
      .optional()
      .describe('The Nexus failure-taxonomy class (§9.2), e.g. `RATE_LIMITED`.'),
    remediation: z.string().optional().describe('What the caller can do about it.'),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Field-level validation failures, when the problem is a VALIDATION one.'),
  })
  .openapi('Problem');
export type Problem = z.infer<typeof problemSchema>;

function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// ── object types ────────────────────────────────────────────────────────────

export const objectTypeSchema = z
  .object({
    id: uuid,
    apiSlug: z.string(),
    singular: z.string(),
    plural: z.string(),
    icon: z.string().nullable(),
    description: z.string().nullable(),
    isSystem: z.boolean(),
    recordCount: z.number().int().optional(),
  })
  .openapi('ObjectType');

export const objectTypePageSchema = page(objectTypeSchema);

export const createObjectTypeSchema = z.object({
  apiSlug: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase letters, digits and underscores')
    .describe('The slug this object is addressed by in `/v1/objects/{slug}/records`.'),
  singular: z.string().trim().min(1).max(60),
  plural: z.string().trim().min(1).max(60),
  icon: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
});

// ── attributes (returned alongside records so a client can interpret `values`) ─

export const attributeSchema = z
  .object({
    id: uuid,
    apiSlug: z.string(),
    title: z.string(),
    type: z.string(),
    isRequired: z.boolean(),
    isUnique: z.boolean(),
    isSystem: z.boolean(),
    position: z.number().int(),
  })
  .openapi('Attribute');

// ── records ─────────────────────────────────────────────────────────────────

export const recordSchema = z
  .object({
    id: uuid,
    objectTypeId: uuid,
    /** Keyed by attribute id. The `attributes` array on a list response maps ids to slugs. */
    values: jsonObject,
    label: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable(),
  })
  .openapi('Record');

export const recordPageSchema = z.object({
  items: z.array(recordSchema),
  nextCursor: z.string().nullable(),
  attributes: z.array(attributeSchema),
  objectType: objectTypeSchema,
});

export const recordValuesSchema = z.object({
  values: jsonObject.describe('Keyed by attribute id or apiSlug.'),
});

export const deletedSchema = z.object({ id: uuid, deleted: z.literal(true) });

/**
 * The cursor-paginated filter DSL. This is `RecordQuery` from @nexus/core verbatim — the same
 * object `queryRecords()` takes, which is why this endpoint needed wiring rather than building.
 */
export const recordQueryBodySchema = reHome(coreRecordQuerySchema).openapi('RecordQuery');
export const filterSchema = reHome(coreFilterSchema).openapi('Filter');
export const sortSchema = reHome(coreSortSchema).openapi('Sort');

// ── list entries ────────────────────────────────────────────────────────────

export const listEntrySchema = z
  .object({
    id: uuid,
    listId: uuid,
    recordId: uuid,
    label: z.string(),
    stage: z.string().nullable(),
    position: z.number(),
    values: jsonObject,
    createdAt: isoDateTime,
  })
  .openapi('ListEntry');

export const listEntryPageSchema = page(listEntrySchema);

export const createListEntrySchema = z.object({
  recordId: uuid,
  stage: z.string().max(64).optional(),
  values: jsonObject.optional(),
});

// ── timeline ────────────────────────────────────────────────────────────────

export const timelineEventSchema = z
  .object({
    id: uuid,
    type: z.string(),
    platform: z.string().nullable(),
    occurredAt: isoDateTime,
    summary: z.string(),
    sourceUrl: z.string().nullable(),
    recordId: uuid.nullable(),
    provenance: z.enum(['record', 'identity']),
    connection: z.object({ id: uuid, label: z.string(), platform: z.string() }).nullable(),
    payload: jsonValue.optional(),
  })
  .openapi('TimelineEvent');

export const timelinePageSchema = z.object({
  items: z.array(timelineEventSchema),
  nextCursor: z.string().nullable(),
  facets: z.object({
    platforms: z.record(z.string(), z.number().int()),
    types: z.record(z.string(), z.number().int()),
  }),
});

export const timelineQuerySchema = pageQuerySchema.extend({
  platform: z
    .string()
    .optional()
    .openapi({ param: { description: 'Filter to one platform, e.g. `INSTAGRAM`.' } }),
  type: z
    .string()
    .optional()
    .openapi({ param: { description: 'Filter to one event type, e.g. `MESSAGE`.' } }),
});

// ── conversations and messages ──────────────────────────────────────────────

export const conversationSchema = z
  .object({
    id: uuid,
    kind: z.string(),
    status: z.string(),
    subject: z.string().nullable(),
    platform: z.string(),
    connectionId: uuid,
    personRecordId: uuid.nullable(),
    identityId: uuid.nullable(),
    assigneeId: uuid.nullable(),
    tags: z.array(z.string()),
    slaDueAt: isoDateTime.nullable(),
    lastMessageAt: isoDateTime,
    unreadCount: z.number().int(),
  })
  .openapi('Conversation');

export const conversationPageSchema = page(conversationSchema);

export const conversationListQuerySchema = pageQuerySchema.extend({
  status: z.enum(['OPEN', 'SNOOZED', 'CLOSED', 'SPAM']).optional(),
  platform: z.string().optional(),
  connectionId: uuid.optional(),
});

export const messageSchema = z
  .object({
    id: uuid,
    conversationId: uuid,
    direction: z.enum(['INBOUND', 'OUTBOUND']),
    body: z.string().nullable(),
    sentAt: isoDateTime,
    deliveryState: z.string(),
    sourceUrl: z.string().nullable(),
  })
  .openapi('Message');

export const messagePageSchema = page(messageSchema);

export const createMessageSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  /**
   * Collapses a retried send onto the same OutboundAction. Optional over REST: when it is
   * omitted the `Idempotency-Key` header (or a generated nonce) takes its place.
   */
  requestNonce: z.string().min(8).max(64).optional(),
});

/**
 * The same outcome the in-app composer gets: the send goes through `preflight` and lands as an
 * `OutboundAction`, so a platform policy block is a 200 with `status: "blocked"`, not an error.
 */
export const replyOutcomeSchema = z
  .object({
    status: z.enum(['queued', 'duplicate', 'blocked']),
    outboundActionId: uuid,
    duplicate: z.boolean(),
    warnings: z.array(z.string()).optional(),
    code: z.string().optional(),
    reason: z.string().optional(),
    remediation: z.string().optional(),
  })
  .openapi('ReplyOutcome');

// ── connections ─────────────────────────────────────────────────────────────

export const connectionSchema = z
  .object({
    id: uuid,
    platform: z.string(),
    label: z.string(),
    status: z.string(),
    accountExternalId: z.string(),
    accountName: z.string(),
    apiVersion: z.string(),
    scopesGranted: z.array(z.string()),
    capabilities: z.array(z.string()),
    pausedReason: z.string().nullable(),
    lastSyncAt: isoDateTime.nullable(),
    tokenExpiresAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
  })
  .openapi('Connection');

export const connectionPageSchema = page(connectionSchema);

export const connectionHealthSchema = z
  .object({
    connectionId: uuid,
    label: z.string(),
    platform: z.string(),
    status: z.string(),
    everythingFine: z.boolean(),
    budget: jsonValue.nullable().describe('The connector’s live budget snapshot, or null.'),
    tokenExpiresAt: isoDateTime.nullable(),
    tokenExpiringSoon: z.boolean(),
    failedRuns24h: z.number().int(),
    openErrors: z.number().int(),
    webhooks: z.object({
      received: z.number().int(),
      rejected: z.number().int(),
      unprocessed: z.number().int(),
    }),
    driftCount: z.number().int().nullable(),
  })
  .openapi('ConnectionHealth');

export const syncRunSchema = z
  .object({
    id: uuid,
    connectionId: uuid,
    resource: z.string(),
    trigger: z.string(),
    status: z.string(),
    startedAt: isoDateTime,
    finishedAt: isoDateTime.nullable(),
    itemsFetched: z.number().int(),
    itemsCreated: z.number().int(),
    itemsUpdated: z.number().int(),
    itemsSkipped: z.number().int(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .openapi('SyncRun');

export const syncRunPageSchema = page(syncRunSchema);

export const syncRequestSchema = z.object({
  resource: z.string().max(120).optional().describe('One resource id; omit for all of them.'),
  backfill: z.boolean().default(false),
});

export const enqueuedSchema = z.object({ jobIds: z.array(z.string()) });

export const connectionStatusSchema = z.object({ id: uuid, status: z.string() });

export const pauseRequestSchema = z.object({ reason: z.string().max(200).optional() });

export const replayRequestSchema = z.object({
  fromStage: z
    .enum(['normalize', 'materialize'])
    .default('normalize')
    .describe('Which pipeline stage to replay the run’s raw objects from (§4.1).'),
});

export const replayResultSchema = z.object({
  runId: uuid,
  resource: z.string(),
  objects: z.number().int(),
  jobs: z.number().int(),
});

// ── search ──────────────────────────────────────────────────────────────────

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limitPerObject: z.coerce.number().int().min(1).max(20).default(5),
});

export const searchResultSchema = z.object({
  q: z.string(),
  groups: z.array(
    z.object({
      objectType: objectTypeSchema.pick({
        id: true,
        apiSlug: true,
        singular: true,
        plural: true,
      }),
      items: z.array(recordSchema),
      more: z.boolean(),
    }),
  ),
});
