/**
 * Shared plumbing for the feature functions: the `AiDeps` bag every one of them takes, how a
 * conversation's and a person's `TimelineEvent`s are gathered into prompt context, and the
 * citation filter that makes "cites real timeline events" structural rather than a hope.
 */
import type { TenantDb } from '@nexus/db';
import type { AiModel } from './model.ts';
import type { AiSettings } from './budget.ts';
import { redactPii } from './redact.ts';
import type { ContextEvent } from './prompts.ts';

export type AiDeps = {
  db: TenantDb;
  model: AiModel;
  now(): Date;
  settings: AiSettings;
};

export type AiInsightResult = {
  insightId: string;
  content: unknown;
  citations: string[];
  confidence: number;
  model: string;
  promptVersion: string;
};

/** How many timeline events at most go into one prompt. */
export const CONTEXT_EVENT_LIMIT = 30;

type TimelineRowish = {
  id: string;
  occurredAt: Date;
  type: string;
  platform: string | null;
  summary: string;
  payload: unknown;
};

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function payloadString(payload: unknown, key: string): string | null {
  if (!isDict(payload)) return null;
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function toContextEvent(row: TimelineRowish, level: AiSettings['piiRedaction']): ContextEvent {
  const body = payloadString(row.payload, 'body') ?? row.summary;
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    type: row.type,
    platform: row.platform,
    text: redactPii(body, level),
  };
}

/**
 * The conversation ↔ timeline join. There is no foreign key between them: every ingest sink
 * stamps `payload.conversationExternalId`, so that is the contract. Narrow in SQL by connection
 * and subject (the indexed path), then filter to the thread in application code.
 */
export async function conversationContext(
  db: TenantDb,
  settings: AiSettings,
  conversation: {
    externalId: string;
    connectionId: string;
    identityId: string | null;
    personRecordId: string | null;
  },
  limit = CONTEXT_EVENT_LIMIT,
): Promise<ContextEvent[]> {
  const subject: { recordId?: string; identityId?: string }[] = [];
  if (conversation.personRecordId) subject.push({ recordId: conversation.personRecordId });
  if (conversation.identityId) subject.push({ identityId: conversation.identityId });
  if (!subject.length) return [];

  const rows = await db.timelineEvent.findMany({
    where: { connectionId: conversation.connectionId, deletedAt: null, OR: subject },
    orderBy: { occurredAt: 'desc' },
    take: limit * 4,
    select: {
      id: true,
      occurredAt: true,
      type: true,
      platform: true,
      summary: true,
      payload: true,
    },
  });

  return rows
    .filter((r) => payloadString(r.payload, 'conversationExternalId') === conversation.externalId)
    .slice(0, limit)
    .map((r) => toContextEvent(r, settings.piiRedaction));
}

/** Everything on one person, across every channel (§13.2). */
export async function personContext(
  db: TenantDb,
  settings: AiSettings,
  recordId: string,
  limit = CONTEXT_EVENT_LIMIT,
): Promise<ContextEvent[]> {
  const identities = await db.identity.findMany({
    where: { personRecordId: recordId, deletedAt: null },
    select: { id: true },
  });
  const rows = await db.timelineEvent.findMany({
    where: {
      deletedAt: null,
      OR: [
        { recordId },
        ...(identities.length ? [{ identityId: { in: identities.map((i) => i.id) } }] : []),
      ],
    },
    orderBy: { occurredAt: 'desc' },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      type: true,
      platform: true,
      summary: true,
      payload: true,
    },
  });
  return rows.map((r) => toContextEvent(r, settings.piiRedaction));
}

/**
 * Drop every citation the model returned that was not in the context we actually supplied. This
 * is what makes the Phase 10 acceptance criterion a property of the code rather than of the
 * model's good behaviour: a stored citation is always a real `TimelineEvent.id`.
 */
export function filterCitations(returned: unknown, allowed: ContextEvent[]): string[] {
  const set = new Set(allowed.map((e) => e.id));
  const list = Array.isArray(returned) ? returned : [];
  const out: string[] = [];
  for (const c of list) {
    if (typeof c === 'string' && set.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** A short, redacted rendering of a record's values for a prompt's RECORD block. */
export function renderRecordValues(
  values: unknown,
  attributes: { id: string; title: string }[],
  level: AiSettings['piiRedaction'],
): string {
  if (!isDict(values)) return '';
  const lines: string[] = [];
  for (const attr of attributes) {
    const v = values[attr.id];
    if (v === undefined || v === null || v === '') continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`${attr.title}: ${redactPii(text, level).slice(0, 300)}`);
  }
  return lines.join('\n');
}
