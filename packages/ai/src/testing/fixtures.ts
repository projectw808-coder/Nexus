/**
 * Shared PGlite fixtures for this package's DB-backed tests: one workspace, a Person object type,
 * a connection, an identity linked to a person record, a conversation, and a handful of
 * TimelineEvents carrying `payload.conversationExternalId` exactly the way every ingest sink
 * stamps it. Not exported from the package index — test scaffolding only.
 */
import type { Actor, TenantDb } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import type { AiSettings } from '../budget.ts';

export type Fixture = {
  db: TestDatabase;
  actor: Actor;
  workspaceId: string;
  userId: string;
  objectTypeId: string;
  nameAttributeId: string;
  researchAttributeId: string;
  connectionId: string;
  identityId: string;
  personRecordId: string;
  conversationId: string;
  conversationExternalId: string;
  /** TimelineEvent ids that belong to the conversation thread. */
  threadEventIds: string[];
  /** A TimelineEvent on the same person/connection but a *different* thread. */
  otherThreadEventId: string;
  close(): Promise<void>;
};

export const TEST_SETTINGS: AiSettings = {
  killSwitch: false,
  piiRedaction: 'strict',
  features: {},
};

export function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return { ...TEST_SETTINGS, ...overrides };
}

export const FIXED_NOW = new Date('2026-09-25T12:00:00.000Z');
export const fixedClock = () => FIXED_NOW;

let slugCounter = 0;

export async function createFixture(label: string): Promise<Fixture> {
  const db = await createTestDatabase();
  const suffix = `${label}-${++slugCounter}`;
  const user = await db.prisma.user.create({
    data: { email: `owner@${suffix}.test`, name: 'Owner' },
  });
  const ws = await db.tenancy.createWorkspace({
    name: `AI ${suffix}`,
    slug: `ai-${suffix}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.id;
  const actor: Actor = { workspaceId, userId: user.id, role: 'OWNER', grants: [] };

  const built = await db.runtime.withTenant(actor, async (t) =>
    buildGraph(t, workspaceId, user.id),
  );

  return {
    db,
    actor,
    workspaceId,
    userId: user.id,
    ...built,
    close: () => db.close(),
  };
}

async function buildGraph(t: TenantDb, workspaceId: string, userId: string) {
  // `createWorkspace` already seeded the system object types (§6.1), so build on Person.
  const objectType = await t.objectType.findFirstOrThrow({ where: { apiSlug: 'person' } });
  const name = await t.attribute.findFirstOrThrow({
    where: { objectTypeId: objectType.id, apiSlug: 'name' },
  });
  const research = await t.attribute.create({
    data: {
      workspaceId,
      objectTypeId: objectType.id,
      apiSlug: 'employer',
      title: 'Employer',
      type: 'AI_RESEARCH',
      position: 90,
      config: { prompt: 'Who does this person work for?', outputType: 'TEXT' },
    },
  });

  const record = await t.record.create({
    data: {
      workspaceId,
      objectTypeId: objectType.id,
      values: { [name.id]: 'Ada Lovelace' },
      createdById: userId,
    },
  });

  const connection = await t.connection.create({
    data: {
      workspaceId,
      platform: 'INSTAGRAM',
      label: 'IG test',
      accountExternalId: 'acct_ai',
      accountName: 'acct_ai',
      apiVersion: 'v1',
      tokenRef: 'vault_ai',
      ownerUserId: userId,
    },
  });

  const identity = await t.identity.create({
    data: {
      workspaceId,
      platform: 'INSTAGRAM',
      externalId: 'ig_ada',
      handle: 'ada',
      displayName: 'Ada',
      personRecordId: record.id,
    },
  });

  const conversationExternalId = 'thread_1';
  const conversation = await t.conversation.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      platform: 'INSTAGRAM',
      kind: 'DM',
      externalId: conversationExternalId,
      identityId: identity.id,
      personRecordId: record.id,
      lastMessageAt: new Date('2026-09-24T10:00:00.000Z'),
    },
  });

  const thread: { body: string; at: string }[] = [
    {
      body: 'Hi! What does the Pro plan cost? Reach me at ada@example.com',
      at: '2026-09-24T09:00:00.000Z',
    },
    {
      body: 'Also, do you ship to the UK? My number is +44 20 7946 0958',
      at: '2026-09-24T09:30:00.000Z',
    },
    { body: 'Still waiting on that quote, thanks.', at: '2026-09-24T10:00:00.000Z' },
  ];
  const threadEventIds: string[] = [];
  for (const [i, m] of thread.entries()) {
    const row = await t.timelineEvent.create({
      data: {
        workspaceId,
        recordId: record.id,
        identityId: identity.id,
        type: 'MESSAGE',
        platform: 'INSTAGRAM',
        connectionId: connection.id,
        occurredAt: new Date(m.at),
        summary: `Instagram DM from Ada (${i + 1})`,
        dedupeKey: `ig:msg:${i}`,
        payload: { body: m.body, conversationExternalId, direction: 'INBOUND' },
      },
      select: { id: true },
    });
    threadEventIds.push(row.id);
  }

  const other = await t.timelineEvent.create({
    data: {
      workspaceId,
      recordId: record.id,
      identityId: identity.id,
      type: 'COMMENT',
      platform: 'INSTAGRAM',
      connectionId: connection.id,
      occurredAt: new Date('2026-09-20T08:00:00.000Z'),
      summary: 'Instagram comment from Ada',
      dedupeKey: 'ig:cmt:0',
      payload: { body: 'Love this post', conversationExternalId: 'thread_other' },
    },
    select: { id: true },
  });

  return {
    objectTypeId: objectType.id,
    nameAttributeId: name.id,
    researchAttributeId: research.id,
    connectionId: connection.id,
    identityId: identity.id,
    personRecordId: record.id,
    conversationId: conversation.id,
    conversationExternalId,
    threadEventIds,
    otherThreadEventId: other.id,
  };
}
