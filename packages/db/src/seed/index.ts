/**
 * Appendix B — seed & demo data. `pnpm --filter @nexus/db seed -- --empty` produces just the
 * skeleton (workspaces, users, system objects, zero content) so every screen's empty state can
 * be exercised; `--demo` (the default) additionally fills one workspace with realistic content
 * so every screen and chart has something to show on first run.
 *
 * Content lands in `TenantDb` via `runtime.withSystem`/`withTenant` like everything else in this
 * codebase — RLS applies even here. Volume tables (TimelineEvent, Message, Conversation, Identity)
 * use raw SQL set-based inserts (the `seedInboxLoad` / `objects.test.ts` 100k-row pattern already
 * established in this package) since the target counts (12k+ rows) would be too slow one row at a
 * time through the ORM; everything else uses plain Prisma calls.
 *
 * Connections are shaped as if pointed at the mock platform (§Appendix B: "all pointed at the mock
 * platform server") but this script does not itself start a listening mock server — it is a
 * one-shot CLI, not a long-running process. A developer who wants a seeded connection to actually
 * sync starts the mock server themselves (as the e2e suite does) and reconnects it for real; the
 * seeded rows exist so the Integrations hub, health console and connection-detail screens have
 * something realistic to render immediately.
 */
import { randomUUID } from 'node:crypto';
import { generateMasterKeyBase64, localKeyProvider } from '@nexus/connector-sdk';
import { DEAL_STAGES } from '../objects/system.ts';
import { createVault } from '../vault.ts';
import { runtime as defaultRuntime, tenancy as defaultTenancy } from '../runtime.ts';
import type { TenantRuntime } from '../scoped.ts';
import type { Tenancy } from '../tenancy.ts';
import { systemActorFor } from '../sync/connections.ts';
import {
  companyName,
  domainOf,
  fullName,
  industry,
  jobTitle,
  messageSnippet,
  pick,
  seededRandom,
} from './words.ts';

const PLATFORMS_FOR_CONNECTIONS = [
  'FACEBOOK',
  'INSTAGRAM',
  'X',
  'LINKEDIN',
  'TIKTOK',
  'YOUTUBE',
  'KEITARO',
] as const;

export type SeedOptions = {
  runtime?: TenantRuntime;
  tenancy?: Tenancy;
  /** Deterministic PRNG seed — same seed, same-shaped output. */
  randomSeed?: number;
};

function vaultFor() {
  const masterKeyBase64 =
    process.env['ENCRYPTION_KEY_FALLBACK'] && process.env['ENCRYPTION_KEY_FALLBACK'].length > 0
      ? process.env['ENCRYPTION_KEY_FALLBACK']
      : generateMasterKeyBase64();
  const masterKeyId = process.env['KMS_MASTER_KEY_ID'] ?? 'local:seed';
  return createVault({
    keyProvider: localKeyProvider({
      masterKeyId: masterKeyId.startsWith('local:') ? masterKeyId : 'local:seed',
      masterKeyBase64,
    }),
  });
}

/** Just the skeleton: workspaces, users across every role, system objects. Zero content. */
export async function seedEmpty(
  opts: SeedOptions = {},
): Promise<{ acmeId: string; globexId: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const tenancy = opts.tenancy ?? defaultTenancy;

  const users = await runtime.withSystem(async (db) => {
    const rows = await Promise.all(
      [
        ['owner@acme.demo', 'Alex Owner'],
        ['admin@acme.demo', 'Blair Admin'],
        ['manager@acme.demo', 'Cass Manager'],
        ['member@acme.demo', 'Dana Member'],
        ['viewer@acme.demo', 'Evan Viewer'],
        ['owner@globex.demo', 'Frankie Founder'],
      ].map(([email, name]) =>
        db.user.upsert({
          where: { email: email! },
          update: {},
          create: { email: email!, name: name! },
        }),
      ),
    );
    return {
      owner: rows[0]!,
      admin: rows[1]!,
      manager: rows[2]!,
      member: rows[3]!,
      viewer: rows[4]!,
      globexOwner: rows[5]!,
    };
  });

  const acme = await tenancy.createWorkspace({
    name: 'Acme Media',
    slug: 'acme-demo',
    ownerUserId: users.owner.id,
  });
  const globex = await tenancy.createWorkspace({
    name: 'Globex Growth',
    slug: 'globex-demo',
    ownerUserId: users.globexOwner.id,
  });

  await runtime.withSystem((db) =>
    db.membership.createMany({
      data: [
        { workspaceId: acme.id, userId: users.admin.id, role: 'ADMIN', joinedAt: new Date() },
        { workspaceId: acme.id, userId: users.manager.id, role: 'MANAGER', joinedAt: new Date() },
        { workspaceId: acme.id, userId: users.member.id, role: 'MEMBER', joinedAt: new Date() },
        { workspaceId: acme.id, userId: users.viewer.id, role: 'VIEWER', joinedAt: new Date() },
      ],
      skipDuplicates: true,
    }),
  );

  await tenancy.ensureSystemObjects(acme.id);
  await tenancy.ensureSystemObjects(globex.id);

  return { acmeId: acme.id, globexId: globex.id };
}

async function attributeIds(runtime: TenantRuntime, workspaceId: string, apiSlug: string) {
  return runtime.withSystem(async (db) => {
    const ot = await db.objectType.findFirstOrThrow({ where: { workspaceId, apiSlug } });
    const attrs = await db.attribute.findMany({ where: { objectTypeId: ot.id, deletedAt: null } });
    const byApiSlug = new Map(attrs.map((a) => [a.apiSlug, a.id]));
    return { objectTypeId: ot.id, byApiSlug };
  });
}

/** The full Appendix B demo: fills "Acme Media" (`acmeId`); "Globex Growth" stays empty, the
 * same "one rich workspace, one bare one" shape this project's own test fixtures already use. */
export async function seedDemo(opts: SeedOptions = {}): Promise<void> {
  const runtime = opts.runtime ?? defaultRuntime;
  const rng = seededRandom(opts.randomSeed ?? 42);
  const { acmeId } = await seedEmpty(opts);
  const actor = systemActorFor(acmeId);
  const vault = vaultFor();

  // ── Connections: one per platform, "pointed at" the mock platform (see file header) ──────────
  const connectionIds: Record<string, string> = {};
  await runtime.withTenant(actor, async (db) => {
    for (const platform of PLATFORMS_FOR_CONNECTIONS) {
      const { ref } = await vault.put(db, {
        workspaceId: acmeId,
        kind: platform === 'KEITARO' ? 'API_KEY' : 'OAUTH_TOKEN',
        secret: `demo-${platform.toLowerCase()}-${randomUUID()}`,
      });
      const c = await db.connection.create({
        data: {
          workspaceId: acmeId,
          platform,
          label: `${platform[0]}${platform.slice(1).toLowerCase()} — Demo Account`,
          accountExternalId: `demo_${platform.toLowerCase()}_1`,
          accountName: `Demo ${platform[0]}${platform.slice(1).toLowerCase()} Account`,
          scopesGranted: ['read'],
          scopesRequired: ['read'],
          capabilities: ['read'],
          apiVersion: 'demo',
          tokenRef: ref,
          ownerUserId: null,
          status: 'CONNECTED',
        },
        select: { id: true },
      });
      connectionIds[platform] = c.id;
    }
  });

  // ── People & companies ────────────────────────────────────────────────────────────────────────
  const person = await attributeIds(runtime, acmeId, 'person');
  const company = await attributeIds(runtime, acmeId, 'company');
  const deal = await attributeIds(runtime, acmeId, 'deal');
  const P = (slug: string) => person.byApiSlug.get(slug)!;
  const CO = (slug: string) => company.byApiSlug.get(slug)!;
  const D = (slug: string) => deal.byApiSlug.get(slug)!;

  const COMPANY_COUNT = 400;
  const PEOPLE_COUNT = 2500;

  const companyRows = Array.from({ length: COMPANY_COUNT }, (_, i) => {
    const name = `${companyName(rng)} ${i}`;
    return {
      id: randomUUID(),
      workspaceId: acmeId,
      objectTypeId: company.objectTypeId,
      values: {
        [CO('name')]: name,
        [CO('domain')]: domainOf(name),
        [CO('industry')]: industry(rng),
      },
    };
  });
  await runtime.withTenant(actor, (db) =>
    db.record.createMany({ data: companyRows, skipDuplicates: true }),
  );

  const peopleRows = Array.from({ length: PEOPLE_COUNT }, () => {
    const { name } = fullName(rng);
    const co = pick(rng, companyRows);
    return {
      id: randomUUID(),
      workspaceId: acmeId,
      objectTypeId: person.objectTypeId,
      values: {
        [P('name')]: name,
        [P('email')]:
          `${name.toLowerCase().replace(/\s+/g, '.')}.${Math.floor(rng() * 10_000)}@example.test`,
        [P('title')]: jobTitle(rng),
        [P('company')]: [co.id],
      },
    };
  });
  await runtime.withTenant(actor, async (db) => {
    for (let i = 0; i < peopleRows.length; i += 500) {
      await db.record.createMany({ data: peopleRows.slice(i, i + 500), skipDuplicates: true });
    }
  });

  // ── Pipelines & deals with attribution (§8.6) ─────────────────────────────────────────────────
  const pipelineNames = ['Sales pipeline', 'Partnerships', 'Renewals'];
  const pipelines = await runtime.withTenant(actor, async (db) => {
    const rows: { id: string; stageAttrId: string }[] = [];
    for (const name of pipelineNames) {
      const existing = await db.list.findFirst({
        where: { workspaceId: acmeId, objectTypeId: deal.objectTypeId, name },
        select: { id: true },
      });
      const list =
        existing ??
        (await db.list.create({
          data: {
            workspaceId: acmeId,
            objectTypeId: deal.objectTypeId,
            name,
            kind: 'PIPELINE',
            settings: { stages: DEAL_STAGES.map((s) => s.id) },
          },
          select: { id: true },
        }));
      const stageAttr = await db.listAttribute.upsert({
        where: {
          workspaceId_listId_apiSlug: { workspaceId: acmeId, listId: list.id, apiSlug: 'stage' },
        },
        update: {},
        create: {
          workspaceId: acmeId,
          listId: list.id,
          apiSlug: 'stage',
          title: 'Stage',
          type: 'STATUS',
          config: { options: DEAL_STAGES.map((s) => ({ ...s })) },
        },
        select: { id: true },
      });
      rows.push({ id: list.id, stageAttrId: stageAttr.id });
    }
    return rows;
  });

  const CAMPAIGNS = ['spring_launch', 'creator_collab', 'retarget_q3', 'referral', 'organic_push'];
  const SOURCES = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin'];
  const DEAL_COUNT = 180;
  const dealRows = Array.from({ length: DEAL_COUNT }, (_, i) => {
    const p = pick(rng, peopleRows);
    const co = pick(rng, companyRows);
    const stage = pick(rng, DEAL_STAGES);
    return {
      id: randomUUID(),
      workspaceId: acmeId,
      objectTypeId: deal.objectTypeId,
      pipelineIdx: i % pipelines.length,
      stageId: stage.id,
      values: {
        [D('name')]: `${co.values[CO('name')]} — deal ${i}`,
        [D('amount')]: Math.round((200 + rng() * 9800) * 100) / 100,
        [D('person')]: [p.id],
        [D('company')]: [co.id],
        [D('attribution_campaign')]: pick(rng, CAMPAIGNS),
        [D('attribution_source')]: pick(rng, SOURCES),
        [D('attribution_offer')]: `offer_${1 + Math.floor(rng() * 6)}`,
      },
    };
  });
  await runtime.withTenant(actor, async (db) => {
    for (let i = 0; i < dealRows.length; i += 100) {
      await db.record.createMany({
        data: dealRows
          .slice(i, i + 100)
          .map(({ pipelineIdx: _pipelineIdx, stageId: _stageId, ...r }) => r),
        skipDuplicates: true,
      });
    }
    for (const [i, d] of dealRows.entries()) {
      const pl = pipelines[d.pipelineIdx]!;
      await db.listEntry.create({
        data: {
          workspaceId: acmeId,
          listId: pl.id,
          recordId: d.id,
          stage: d.stageId,
          position: i,
          values: { [pl.stageAttrId]: d.stageId },
        },
      });
    }
  });

  // ── Identities, conversations, messages, timeline events (bulk SQL — seedInboxLoad's pattern) ─
  const TIMELINE_COUNT = 12_000;
  const CONVERSATION_COUNT = 900;
  await runtime.withSystem(async (db) => {
    const platformList = PLATFORMS_FOR_CONNECTIONS.filter((p) => p !== 'KEITARO');
    await db.$executeRawUnsafe(
      `INSERT INTO "Identity" ("id","workspaceId","platform","externalId","handle","displayName","raw","firstSeenAt","lastSeenAt","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, ($3::text[])[1 + (g % array_length($3::text[],1))]::"Platform",
              'demo:u' || g, 'demo_user_' || g, 'Demo Commenter ' || g, '{}'::jsonb,
              now() - ((g % 90) || ' days')::interval, now() - ((g % 5) || ' days')::interval, now(), now()
       FROM generate_series(1, $2::int) g
       ON CONFLICT DO NOTHING`,
      acmeId,
      CONVERSATION_COUNT,
      platformList,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id","workspaceId","connectionId","platform","kind","externalId","identityId","status","lastMessageAt","unreadCount","tags","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1,
              (SELECT id FROM "Connection" WHERE "workspaceId" = $1 AND platform = i."platform" LIMIT 1),
              i."platform",
              (ARRAY['DM','COMMENT_THREAD','MENTION'])[1 + (g % 3)]::"ConversationKind",
              'demo:conv:' || g, i."id",
              (ARRAY['OPEN','OPEN','OPEN','CLOSED','SNOOZED'])[1 + (g % 5)]::"ConvStatus",
              now() - ((g % 30) || ' days')::interval,
              CASE WHEN g % 4 = 0 THEN 1 ELSE 0 END,
              ARRAY[]::text[], now(), now()
       FROM generate_series(1, $2::int) g
       JOIN "Identity" i ON i."workspaceId" = $1 AND i."externalId" = 'demo:u' || g
       ON CONFLICT DO NOTHING`,
      acmeId,
      CONVERSATION_COUNT,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Message" ("id","workspaceId","conversationId","externalId","direction","authorIdentityId","body","attachments","sentAt","deliveryState","raw","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, c."id", c."externalId" || ':m1', 'INBOUND', c."identityId",
              ($2::text[])[1 + (g % array_length($2::text[],1))], '[]'::jsonb,
              c."lastMessageAt", 'DELIVERED', '{}'::jsonb, now(), now()
       FROM "Conversation" c
       CROSS JOIN generate_series(1,1) g
       WHERE c."workspaceId" = $1 AND c."externalId" LIKE 'demo:conv:%'
         AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c."id")`,
      acmeId,
      Array.from({ length: 10 }, () => messageSnippet(rng)),
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "TimelineEvent" ("id","workspaceId","identityId","type","platform","occurredAt","summary","payload","dedupeKey","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, i."id",
              (ARRAY['MESSAGE','COMMENT','MENTION','POST_ENGAGEMENT']::"TimelineType"[])[1 + (g % 4)],
              i."platform",
              now() - ((g % 30) || ' days')::interval - ((g % 24) || ' hours')::interval,
              'Demo activity ' || g,
              jsonb_build_object('kind','demo','direction','inbound','body', ($2::text[])[1 + (g % array_length($2::text[],1))]),
              'demo:tl:' || g, now(), now()
       FROM generate_series(1, $3::int) g
       JOIN "Identity" i ON i."workspaceId" = $1 AND i."externalId" = 'demo:u' || (1 + (g % $4::int))
       ON CONFLICT DO NOTHING`,
      acmeId,
      Array.from({ length: 10 }, () => messageSnippet(rng)),
      TIMELINE_COUNT,
      CONVERSATION_COUNT,
    );
  });

  // ── Merge suggestions ──────────────────────────────────────────────────────────────────────────
  await runtime.withSystem(async (db) => {
    const identities = await db.identity.findMany({
      where: { workspaceId: acmeId, externalId: { startsWith: 'demo:u' } },
      select: { id: true },
      take: 80,
    });
    const suggestions = [];
    for (let i = 0; i + 1 < 80 && suggestions.length < 40; i += 2) {
      suggestions.push({
        workspaceId: acmeId,
        identityId: identities[i]?.id,
        rightRecordId: pick(rng, peopleRows).id,
        score: 0.4 + rng() * 0.4,
        signals: { score: 0.5, method: 'NAME_FUZZY', signals: [] },
        status: 'PENDING' as const,
      });
    }
    await db.mergeSuggestion.createMany({
      data: suggestions.filter((s): s is typeof s & { identityId: string } => !!s.identityId),
      skipDuplicates: true,
    });
  });

  // ── Keitaro conversions (§8.6) ─────────────────────────────────────────────────────────────────
  const KEITARO_COUNT = 4000;
  await runtime.withSystem(async (db) => {
    const keitaroConnId = connectionIds['KEITARO'];
    if (!keitaroConnId) return;
    const statuses = ['lead', 'sale', 'rejected'];
    const dealIds = dealRows.map((d) => d.id);
    await db.$executeRawUnsafe(
      `INSERT INTO "KeitaroConversionState"
         ("id","workspaceId","connectionId","subid","tid","dealRecordId","lastConversionExternalId","lastStatus","appliedPayoutCents","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, $2, 'sub_' || g, 't1',
              ($4::text[])[1 + (g % array_length($4::text[],1))],
              'conv_' || g,
              ($3::text[])[1 + (g % array_length($3::text[],1))],
              CASE WHEN ($3::text[])[1 + (g % array_length($3::text[],1))] = 'sale' THEN 500 + (g % 4500) ELSE 0 END,
              now(), now()
       FROM generate_series(1, $5::int) g
       ON CONFLICT DO NOTHING`,
      acmeId,
      keitaroConnId,
      statuses,
      dealIds,
      KEITARO_COUNT,
    );
  });

  // ── Workflows (Phase 10) ───────────────────────────────────────────────────────────────────────
  await runtime.withTenant(actor, (db) =>
    db.workflow.createMany({
      data: [
        {
          workspaceId: acmeId,
          name: 'Route "price" comments to sales',
          description: 'Instagram comments mentioning price go to the pipeline and get assigned.',
          enabled: true,
          trigger: { type: 'comment.received', platform: 'INSTAGRAM' },
          conditions: { leaf: { path: 'event.payload.body', op: 'contains', value: 'price' } },
          actions: [
            {
              id: 'a1',
              type: 'send_email',
              to: 'sales@acme.demo',
              subject: 'Pricing question',
              body: 'A commenter asked about pricing.',
            },
          ],
        },
        {
          workspaceId: acmeId,
          name: 'Welcome note on new lead',
          enabled: true,
          trigger: { type: 'lead_form.submitted' },
          conditions: [],
          actions: [
            { id: 'a1', type: 'create_task', title: 'Follow up with new lead', dueInHours: 24 },
          ],
        },
        {
          workspaceId: acmeId,
          name: 'Flag high-value deals',
          enabled: false,
          trigger: { type: 'record.updated', objectTypeApiSlug: 'deal' },
          conditions: [],
          actions: [
            { id: 'a1', type: 'create_note', text: 'Deal updated — review for high value.' },
          ],
        },
        {
          workspaceId: acmeId,
          name: 'Mention triage',
          enabled: true,
          trigger: { type: 'mention.received' },
          conditions: [],
          actions: [{ id: 'a1', type: 'wait', seconds: 60 }],
        },
        {
          workspaceId: acmeId,
          name: 'Stage-change note',
          enabled: false,
          trigger: { type: 'list.stage_changed' },
          conditions: [],
          actions: [{ id: 'a1', type: 'create_note', text: 'Stage changed.' }],
        },
        {
          workspaceId: acmeId,
          name: 'New record digest',
          enabled: false,
          trigger: { type: 'record.created', objectTypeApiSlug: 'person' },
          conditions: [],
          actions: [{ id: 'a1', type: 'create_task', title: 'Review new contact' }],
        },
      ],
    }),
  );
}
