/**
 * Load fixture for the inbox (spec §16 Phase 7: p95 < 500 ms with 50k conversations): inserts
 * `count` conversations, each with one inbound message and an identity, in SQL. Lives here
 * because raw SQL is only allowed inside packages/db. Idempotent per `prefix`.
 */
import type { TenantRuntime } from '../scoped.ts';

export async function seedInboxLoad(
  runtime: TenantRuntime,
  input: {
    workspaceId: string;
    connectionId: string;
    count: number;
    prefix?: string;
    assigneeIds?: string[];
  },
): Promise<{ inserted: number }> {
  const prefix = input.prefix ?? 'load';
  const assignees = input.assigneeIds ?? [];
  return runtime.withSystem(async (db) => {
    const existing = await db.conversation.count({
      where: { workspaceId: input.workspaceId, externalId: { startsWith: `${prefix}:` } },
    });
    if (existing >= input.count) return { inserted: 0 };
    const platforms = ['MOCK', 'FACEBOOK', 'INSTAGRAM', 'X', 'LINKEDIN'];
    await db.$executeRawUnsafe(
      `INSERT INTO "Identity" ("id","workspaceId","platform","externalId","handle","displayName","raw","firstSeenAt","lastSeenAt","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, ($3::text[])[1 + (g % 5)]::"Platform", $2 || ':u' || g, 'user' || g, 'Load User ' || g, '{}'::jsonb,
              now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now(), now()
       FROM generate_series(1, $4::int) g
       ON CONFLICT DO NOTHING`,
      input.workspaceId,
      prefix,
      platforms,
      input.count,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id","workspaceId","connectionId","platform","kind","externalId","identityId","status","assigneeId","lastMessageAt","unreadCount","tags","slaDueAt","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, $2, i."platform",
              (ARRAY['DM','COMMENT_THREAD','MENTION'])[1 + (g % 3)]::"ConversationKind",
              $3 || ':' || g, i."id",
              (ARRAY['OPEN','OPEN','OPEN','CLOSED','SNOOZED'])[1 + (g % 5)]::"ConvStatus",
              CASE WHEN cardinality($5::text[]) = 0 OR g % 3 = 0 THEN NULL ELSE ($5::text[])[1 + (g % cardinality($5::text[]))] END,
              now() - (g || ' minutes')::interval,
              CASE WHEN g % 4 = 0 THEN 1 ELSE 0 END,
              CASE WHEN g % 7 = 0 THEN ARRAY['vip'] ELSE ARRAY[]::text[] END,
              CASE WHEN g % 6 = 0 THEN now() - (g || ' minutes')::interval + interval '1 hour' ELSE NULL END,
              now(), now()
       FROM generate_series(1, $4::int) g
       JOIN "Identity" i ON i."workspaceId" = $1 AND i."externalId" = $3 || ':u' || g
       ON CONFLICT DO NOTHING`,
      input.workspaceId,
      input.connectionId,
      prefix,
      input.count,
      assignees,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Message" ("id","workspaceId","conversationId","externalId","direction","authorIdentityId","body","attachments","sentAt","deliveryState","raw","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, c."id", c."externalId" || ':m1', 'INBOUND', c."identityId",
              'Message number ' || substring(c."externalId" from '[0-9]+$') || ' from the load fixture', '[]'::jsonb,
              c."lastMessageAt", 'DELIVERED', '{}'::jsonb, now(), now()
       FROM "Conversation" c
       WHERE c."workspaceId" = $1 AND c."externalId" LIKE $2 || ':%'
         AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c."id")`,
      input.workspaceId,
      prefix,
    );
    return { inserted: input.count - existing };
  });
}
