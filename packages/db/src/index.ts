/**
 * Public surface of @nexus/db.
 *
 * Deliberately NOT exported: `basePrisma` (src/client.ts) and the PrismaClient
 * value. The only sanctioned way to query is `withTenant(actor, fn)` from
 * src/scoped.ts (Phase 1), which will be re-exported from here when it lands.
 */
export { checkDatabase, type DatabaseHealth } from './health.ts';

// Enums (runtime objects + string-literal union types), e.g. `Platform.INSTAGRAM`.
export * from './generated/prisma/enums.ts';

// Model row types, e.g. `Record`, `Conversation`, `TimelineEvent`.
export type * from './generated/prisma/models.ts';

// The `Prisma` namespace for input/output types (`Prisma.RecordWhereInput`, `Prisma.ModelName`).
export type { Prisma, PrismaClient } from './generated/prisma/client.ts';

export { TENANT_MODELS, NON_TENANT_MODELS, isTenantModel } from './tenant-models.ts';

// ── Phase 1: the tenant boundary ────────────────────────────────────────────
export { withTenant, withSystem, runtime, tenancy } from './runtime.ts';
export { createTenantRuntime, scopedClient, scopeArgs, TenantScopeError } from './scoped.ts';
export type {
  Actor,
  ActorGrant,
  TenantDb,
  SystemDb,
  TenantContext,
  TenantRuntime,
} from './scoped.ts';
export { writeAudit, writeSystemAudit, diffOf } from './audit.ts';
export type { AuditEntry } from './audit.ts';
export { createTenancy, hashToken, generateToken, SLUG_PATTERN } from './tenancy.ts';
export type { Tenancy, WorkspaceSummary } from './tenancy.ts';
export { MODEL_META } from './generated-tenant-models.ts';
export type { ModelMeta, RelationMeta } from './generated-tenant-models.ts';

// ── Auth.js adapter (non-tenant tables; lazily bound to the base client) ────
export { authAdapter, createAuthAdapter } from './auth-adapter.ts';
export type { AuthAdapter } from './auth-adapter.ts';

// ── Phase 2: the object graph ────────────────────────────────────────────────
export { SYSTEM_OBJECTS, DEAL_STAGES, seedSystemObjects } from './objects/system.ts';
export {
  loadAttributes,
  toDef,
  attributeAccess,
  visibleAttributes,
  writableAttributes,
  redactValues,
} from './objects/attributes.ts';
export type { AttributeRow } from './objects/attributes.ts';
export {
  queryRecords,
  countRecords,
  createRecord,
  updateRecord,
  softDeleteRecords,
  restoreRecords,
  genColumn,
} from './objects/records.ts';
export type { RecordRow, QueryResult } from './objects/records.ts';
export {
  runIndexBuild,
  dropIndexArtifacts,
  purgeDeletedAttributes,
  pendingIndexBuilds,
} from './objects/indexing.ts';
export type { IndexBuildProgress } from './objects/indexing.ts';
export {
  createList,
  addEntry,
  moveEntry,
  updateEntryValues,
  removeEntry,
  listAttributeDefs,
  stagesOf,
} from './objects/lists.ts';
export type { StageDef } from './objects/lists.ts';
export {
  previewImport,
  suggestMapping,
  runImport,
  rollbackImport,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
} from './objects/imports.ts';
export type {
  ColumnMapping,
  ImportOptions,
  ImportStats,
  RowError,
  Preview,
} from './objects/imports.ts';

// ── Phase 4: connector runtime stores ───────────────────────────────────────
export { createVault } from './vault.ts';
export type { Vault, VaultDb, VaultReadResult } from './vault.ts';
export {
  persistRawItems,
  pendingNormalization,
  contentHashOf,
  stableStringify,
} from './sync/raw-store.ts';
export type { RawInput, PersistRawResult } from './sync/raw-store.ts';
export { loadCursor, saveCursor, clearCursor } from './sync/cursors.ts';
export type { CursorState } from './sync/cursors.ts';
export { startRun, progressRun, finishRun, cancelStaleRuns } from './sync/runs.ts';
export {
  recordWebhookEvent,
  recordSystemWebhookEvent,
  recordUnroutedWebhookEvent,
  markWebhookProcessed,
  unprocessedWebhookEvents,
} from './sync/webhook-events.ts';
export type { WebhookEventInput } from './sync/webhook-events.ts';
export { recordDeadLetter, listDeadLetters, markReplayed } from './sync/dead-letters.ts';
export { recordIntegrationError, toIntegrationErrorClass } from './sync/errors.ts';
export {
  systemActorFor,
  upsertConnection,
  getConnection,
  setConnectionStatus,
  touchConnectionSync,
  updateConnectionSettings,
  findConnectionForWebhook,
  listSchedulableConnections,
  listConnectionsForTokenSweep,
} from './sync/connections.ts';
export type { CreateConnectionInput, ConnectionRow } from './sync/connections.ts';

// ── Phase 6: identity resolution and the unified timeline (§10, §6.3, ADR-017) ──
export * from './identity/index.ts';

// ── Phase 7: realtime (LISTEN/NOTIFY → SSE) ─────────────────────────────────
export { publishEvent, subscribeEvents, closeEventListener, EVENTS_CHANNEL } from './realtime.ts';
export type { NexusEvent } from './realtime.ts';
export { slaMinutesFor, slaDueFor, sweepSnoozed, DEFAULT_SLA_MINUTES } from './inbox.ts';
