/**
 * Row → REST response projections, and the keyset cursor the endpoints that do not go through
 * `queryRecords` share. Every list response is `{ items, nextCursor }` — the same shape
 * `QueryResult` already produces (§11.2), so a client pages every collection the same way.
 *
 * `Date` values are passed through: `JSON.stringify` renders them as the RFC 3339 strings the
 * OpenAPI document declares, so there is no second serialisation to keep in step.
 */
import { MAX_PAGE_LIMIT } from '@nexus/api';
import type { AttributeRow, RecordRow, Actor } from '@nexus/db';
import { publicRecord, recordLabel } from '@/server/objects-helpers';

export function encodeCursor(sortValue: Date | string | number, id: string): string {
  const v = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue);
  return Buffer.from(`${v}|${id}`, 'utf8').toString('base64url');
}

export function decodeDateCursor(
  cursor: string | null | undefined,
): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}

export function decodeNumberCursor(
  cursor: string | null | undefined,
): { value: number; id: string } | null {
  if (!cursor) return null;
  const [raw, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!raw || !id) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? { value, id } : null;
}

/** The `limit` cap of §11.2, applied on the endpoints that do not inherit it from RecordQuery. */
export function cappedLimit(limit: number | undefined, fallback = 50): number {
  return Math.min(Math.max(limit ?? fallback, 1), MAX_PAGE_LIMIT);
}

/** Take `limit + 1` rows, return `limit` of them plus the cursor for the next page. */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => Date | string | number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(sortValueOf(last), last.id) : null,
  };
}

export type ObjectTypeShape = {
  id: string;
  apiSlug: string;
  singular: string;
  plural: string;
  icon: string | null;
  description: string | null;
  isSystem: boolean;
};

export function restObjectType<T extends ObjectTypeShape>(row: T): ObjectTypeShape {
  return {
    id: row.id,
    apiSlug: row.apiSlug,
    singular: row.singular,
    plural: row.plural,
    icon: row.icon,
    description: row.description,
    isSystem: row.isSystem,
  };
}

export function restAttribute(a: AttributeRow) {
  return {
    id: a.id,
    apiSlug: a.apiSlug,
    title: a.title,
    type: a.type,
    isRequired: a.isRequired,
    isUnique: a.isUnique,
    isSystem: a.isSystem,
    position: a.position,
  };
}

export function restRecord(actor: Actor, attrs: AttributeRow[], row: RecordRow) {
  return { ...publicRecord(actor, attrs, row), label: recordLabel(attrs, row.values) };
}

type ConnectionRowish = {
  id: string;
  platform: string;
  label: string;
  status: string;
  accountExternalId: string;
  accountName: string;
  apiVersion: string;
  scopesGranted: string[];
  capabilities: string[];
  pausedReason: string | null;
  lastSyncAt: Date | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
};

/** §5.4: `tokenRef` and `webhookSecretRef` are never projected, not even as opaque handles. */
export function restConnection(c: ConnectionRowish) {
  return {
    id: c.id,
    platform: c.platform,
    label: c.label,
    status: c.status,
    accountExternalId: c.accountExternalId,
    accountName: c.accountName,
    apiVersion: c.apiVersion,
    scopesGranted: c.scopesGranted,
    capabilities: c.capabilities,
    pausedReason: c.pausedReason,
    lastSyncAt: c.lastSyncAt,
    tokenExpiresAt: c.tokenExpiresAt,
    createdAt: c.createdAt,
  };
}

type SyncRunRowish = {
  id: string;
  connectionId: string;
  resource: string;
  trigger: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  itemsFetched: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsSkipped: number;
  errorCode: string | null;
  errorMessage: string | null;
};

export function restSyncRun(r: SyncRunRowish) {
  return {
    id: r.id,
    connectionId: r.connectionId,
    resource: r.resource,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    itemsFetched: r.itemsFetched,
    itemsCreated: r.itemsCreated,
    itemsUpdated: r.itemsUpdated,
    itemsSkipped: r.itemsSkipped,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
  };
}

type ConversationRowish = {
  id: string;
  kind: string;
  status: string;
  subject: string | null;
  platform: string;
  connectionId: string;
  personRecordId: string | null;
  identityId: string | null;
  assigneeId: string | null;
  tags: string[];
  slaDueAt: Date | null;
  lastMessageAt: Date;
  unreadCount: number;
};

export function restConversation(c: ConversationRowish) {
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    subject: c.subject,
    platform: c.platform,
    connectionId: c.connectionId,
    personRecordId: c.personRecordId,
    identityId: c.identityId,
    assigneeId: c.assigneeId,
    tags: c.tags,
    slaDueAt: c.slaDueAt,
    lastMessageAt: c.lastMessageAt,
    unreadCount: c.unreadCount,
  };
}

type MessageRowish = {
  id: string;
  conversationId: string;
  direction: string;
  body: string | null;
  sentAt: Date;
  deliveryState: string;
  sourceUrl: string | null;
};

export function restMessage(m: MessageRowish) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    body: m.body,
    sentAt: m.sentAt,
    deliveryState: m.deliveryState,
    sourceUrl: m.sourceUrl,
  };
}
