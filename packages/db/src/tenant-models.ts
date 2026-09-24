/**
 * Tenant-model registry consumed by the scoped client (§5.3).
 *
 * TENANT_MODELS is generated from the Prisma data model (every model with a
 * `workspaceId` field) by scripts/gen-tenant-models.ts, so a new model is
 * scoped automatically. Workspace itself is NOT in the set: it is the tenant
 * root and the scoped client must restrict it by `id`, not `workspaceId`.
 */
import { Prisma } from './generated/prisma/client.ts';
import { TENANT_MODELS as GENERATED_TENANT_MODELS } from './generated-tenant-models.ts';

export const TENANT_MODELS: ReadonlySet<string> = GENERATED_TENANT_MODELS;

/** Model names (as `Prisma.ModelName`) that do not carry `workspaceId`. */
export const NON_TENANT_MODELS: ReadonlySet<string> = new Set(
  Object.values(Prisma.ModelName).filter((name) => !TENANT_MODELS.has(name)),
);

export function isTenantModel(model: string): boolean {
  return TENANT_MODELS.has(model);
}
