/**
 * Versioning with rollback (§14, ADR-021).
 *
 * A `WorkflowVersion` row is a snapshot of what the workflow's trigger/conditions/actions looked
 * like at version N. Rollback copies an old snapshot back onto the live row and bumps the version
 * again — it never deletes a version, so "we rolled back to v3" is itself a version you can see,
 * audit and roll back out of.
 *
 * These are plain db writes with no execution logic, but they live here because they operate on
 * the workflow's own definition. The tRPC router calls them directly.
 */
import { NexusError } from '@nexus/core';
import { writeAudit, type Actor, type Prisma, type TenantDb } from '@nexus/db';
import type { WorkflowRow } from './types.ts';

const asJson = (value: unknown): Prisma.InputJsonValue => value ?? {};

const WORKFLOW_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  enabled: true,
  trigger: true,
  conditions: true,
  actions: true,
  version: true,
  state: true,
} as const;

/**
 * Snapshot the workflow's CURRENT trigger/conditions/actions as version `workflow.version`.
 * Call it right after bumping `Workflow.version` on an update: it records what the workflow now
 * looks like, versioned. Re-snapshotting the same version overwrites that snapshot rather than
 * failing the unique index, so a retried save is harmless.
 */
export async function snapshotWorkflowVersion(
  db: TenantDb,
  actor: Actor,
  workflow: {
    id: string;
    workspaceId: string;
    version: number;
    trigger: unknown;
    conditions: unknown;
    actions: unknown;
  },
): Promise<void> {
  const existing = await db.workflowVersion.findFirst({
    where: { workflowId: workflow.id, version: workflow.version },
    select: { id: true },
  });
  const payload = {
    trigger: asJson(workflow.trigger),
    conditions: asJson(workflow.conditions),
    actions: asJson(workflow.actions),
  };
  if (existing) {
    await db.workflowVersion.update({ where: { id: existing.id }, data: payload });
    return;
  }
  await db.workflowVersion.create({
    data: {
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      version: workflow.version,
      createdById: actor.userId,
      ...payload,
    },
  });
}

/** Every snapshot of a workflow, newest version first. */
export async function listWorkflowVersions(
  db: TenantDb,
  workflowId: string,
): Promise<{ id: string; version: number; createdAt: Date; createdById: string | null }[]> {
  return db.workflowVersion.findMany({
    where: { workflowId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, createdAt: true, createdById: true },
  });
}

/**
 * Roll back to an earlier version: copy its trigger/conditions/actions onto the live `Workflow`
 * row, bump `version` past everything that exists, and snapshot the result so the rollback is
 * itself an auditable version rather than a destructive edit.
 */
export async function rollbackWorkflow(
  db: TenantDb,
  actor: Actor,
  workflowId: string,
  toVersion: number,
): Promise<WorkflowRow> {
  const snapshot = await db.workflowVersion.findFirst({
    where: { workflowId, version: toVersion },
    select: { trigger: true, conditions: true, actions: true, version: true },
  });
  if (!snapshot) {
    throw new NexusError('NOT_FOUND', {
      context: { reason: `Workflow ${workflowId} has no version ${toVersion}.` },
    });
  }
  const current = await db.workflow.findFirst({
    where: { id: workflowId, deletedAt: null },
    select: { id: true, workspaceId: true, version: true },
  });
  if (!current) throw new NexusError('NOT_FOUND');

  const highest = await db.workflowVersion.findFirst({
    where: { workflowId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = Math.max(current.version, highest?.version ?? 0) + 1;

  const updated = await db.workflow.update({
    where: { id: workflowId },
    data: {
      trigger: asJson(snapshot.trigger),
      conditions: asJson(snapshot.conditions),
      actions: asJson(snapshot.actions),
      version: nextVersion,
    },
    select: WORKFLOW_SELECT,
  });

  await snapshotWorkflowVersion(db, actor, {
    id: updated.id,
    workspaceId: updated.workspaceId,
    version: nextVersion,
    trigger: updated.trigger,
    conditions: updated.conditions,
    actions: updated.actions,
  });

  await writeAudit(db, actor, {
    action: 'workflow.rolled_back',
    targetType: 'Workflow',
    targetId: workflowId,
    diff: { fromVersion: current.version, restoredVersion: toVersion, newVersion: nextVersion },
  });

  return updated;
}
