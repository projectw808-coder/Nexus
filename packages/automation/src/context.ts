/**
 * Assembling the object a workflow's conditions are evaluated against.
 *
 * Deliberately shallow: `{ event }` is always there, and `record` is loaded only when the
 * conditions actually mention `record.` — the common inbox trigger ("a comment containing
 * 'price'") reads nothing but the event, and paying for an attribute load on every ingested
 * message would be a hot-path cost for nothing.
 */
import { loadAttributes, type TenantDb } from '@nexus/db';
import type { AutomationEvent } from './events.ts';
import type { EvaluationContext } from './types.ts';

/** Does this stored condition tree reference `record.*` anywhere? */
export function referencesRecord(conditions: unknown): boolean {
  if (conditions === null || conditions === undefined) return false;
  try {
    return JSON.stringify(conditions).includes('record.');
  } catch {
    return false;
  }
}

/**
 * A record as conditions see it: `record.id`, `record.objectTypeApiSlug`, and every attribute
 * value keyed by its `apiSlug` (`record.email`, `record.stage`, …) plus the raw id-keyed bag at
 * `record.values` for the escape hatch.
 */
export async function loadRecordContext(
  db: TenantDb,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.record.findFirst({
    where: { id: recordId, deletedAt: null },
    select: { id: true, objectTypeId: true, values: true, createdAt: true, updatedAt: true },
  });
  if (!row) return null;

  const objectType = await db.objectType.findFirst({
    where: { id: row.objectTypeId },
    select: { apiSlug: true },
  });
  const attributes = await loadAttributes(db, row.objectTypeId);
  const values = (row.values ?? {}) as Record<string, unknown>;
  const bySlug: Record<string, unknown> = {};
  for (const attribute of attributes) {
    bySlug[attribute.apiSlug] = values[attribute.id] ?? null;
  }

  return {
    ...bySlug,
    id: row.id,
    objectTypeId: row.objectTypeId,
    objectTypeApiSlug: objectType?.apiSlug ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    values,
  };
}

/**
 * Which record does this event describe? The event's own record, else the person behind the
 * conversation it happened on.
 */
export async function resolveContextRecordId(
  db: TenantDb,
  event: AutomationEvent,
): Promise<string | null> {
  if (event.recordId) return event.recordId;
  if (event.conversationId) {
    const conversation = await db.conversation.findFirst({
      where: { id: event.conversationId, deletedAt: null },
      select: { personRecordId: true },
    });
    return conversation?.personRecordId ?? null;
  }
  return null;
}

/** Build `{ event, record? }` for one event, loading the record only when conditions need it. */
export async function buildContext(
  db: TenantDb,
  event: AutomationEvent,
  conditions: unknown,
): Promise<EvaluationContext> {
  if (!referencesRecord(conditions)) return { event };
  const recordId = await resolveContextRecordId(db, event);
  if (!recordId) return { event, record: null };
  return { event, record: await loadRecordContext(db, recordId) };
}
