/**
 * Audit log writes (§5.4). Every mutation writes one row inside the same transaction as the
 * change, so a rolled-back change leaves no audit trace and a committed change never lacks one.
 */
import type { Prisma } from './generated/prisma/client.ts';
import type { Actor, SystemDb, TenantDb } from './scoped.ts';

export type AuditEntry = {
  /** Dotted verb, e.g. `member.role_changed`, `invitation.created`, `record.updated`. */
  action: string;
  /** Model name or logical type, e.g. `Membership`. */
  targetType: string;
  targetId: string;
  /** JSON diff or payload. For updates use `diffOf(before, after)`. */
  diff?: unknown;
};

export async function writeAudit(db: TenantDb, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      actorType: actor.actorType ?? 'USER',
      actorRef: actor.actorRef ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      diff: toJson(entry.diff),
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    },
  });
}

/** Same, from a system transaction (workspace creation, invitation acceptance). */
export async function writeSystemAudit(
  db: SystemDb,
  workspaceId: string,
  actor: Pick<Actor, 'userId' | 'actorType' | 'actorRef' | 'ip' | 'userAgent'>,
  entry: AuditEntry,
): Promise<void> {
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: actor.userId,
      actorType: actor.actorType ?? 'USER',
      actorRef: actor.actorRef ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      diff: toJson(entry.diff),
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    },
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  const plain = JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v)),
  ) as Prisma.InputJsonValue | null;
  return plain ?? {};
}

/** Shallow diff of two plain objects: only keys whose JSON value changed. */
export function diffOf<T extends Record<string, unknown>>(
  before: Partial<T>,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
