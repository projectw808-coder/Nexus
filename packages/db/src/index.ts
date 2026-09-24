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
