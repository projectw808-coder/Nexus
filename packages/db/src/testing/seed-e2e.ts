/**
 * Seeds the e2e workspace used by apps/web/e2e (ADR-012): two users, one workspace, a custom
 * "widget" object with 100k rows inserted in SQL, and a pipeline with a few deals. Idempotent.
 * Lives here because raw SQL is only allowed inside packages/db.
 */
import { createTenancy } from '../tenancy.ts';
import type { Actor, TenantRuntime } from '../scoped.ts';
import { loadAttributes } from '../objects/attributes.ts';
import { createRecord } from '../objects/records.ts';
import { upsertIdentity } from '../identity/identities.ts';
import { linkIdentity } from '../identity/resolve.ts';
import { personAttributes } from '../identity/subjects.ts';
import { emitTimelineEvent } from '../identity/timeline.ts';

export async function seedE2eWorkspace(
  runtime: TenantRuntime,
): Promise<{ created: boolean; workspaceId: string; widgetTypeId: string | null }> {
  const tenancy = createTenancy(runtime);
  const existing = await runtime.withSystem((db) =>
    db.workspace.findUnique({ where: { slug: 'e2e' } }),
  );
  if (existing) return { created: false, workspaceId: existing.id, widgetTypeId: null };

  const alice = await runtime.withSystem((db) =>
    db.user.create({
      data: { email: 'alice@e2e.test', name: 'Alice E2E', emailVerified: new Date() },
    }),
  );
  const viewer = await runtime.withSystem((db) =>
    db.user.create({
      data: { email: 'viewer@e2e.test', name: 'Val Viewer', emailVerified: new Date() },
    }),
  );
  const ws = await tenancy.createWorkspace({
    name: 'E2E Workspace',
    slug: 'e2e',
    ownerUserId: alice.id,
  });
  await runtime.withSystem((db) =>
    db.membership.create({
      data: { workspaceId: ws.id, userId: viewer.id, role: 'VIEWER', joinedAt: new Date() },
    }),
  );

  const widget = await runtime.withSystem((db) =>
    db.objectType.create({
      data: { workspaceId: ws.id, apiSlug: 'widget', singular: 'Widget', plural: 'Widgets' },
    }),
  );
  const mk = (
    apiSlug: string,
    title: string,
    type: 'TEXT' | 'NUMBER' | 'SELECT' | 'BOOLEAN',
    position: number,
    extra: Record<string, unknown> = {},
  ) =>
    runtime.withSystem((db) =>
      db.attribute.create({
        data: {
          workspaceId: ws.id,
          objectTypeId: widget.id,
          apiSlug,
          title,
          type,
          position,
          ...extra,
        },
      }),
    );
  const name = await mk('name', 'Name', 'TEXT', 0, { isRequired: true, isSystem: true });
  const qty = await mk('quantity', 'Quantity', 'NUMBER', 1);
  const tier = await mk('tier', 'Tier', 'SELECT', 2, {
    config: {
      options: [
        { id: 'gold', label: 'Gold' },
        { id: 'silver', label: 'Silver' },
        { id: 'bronze', label: 'Bronze' },
      ],
    },
  });
  const active = await mk('active', 'Active', 'BOOLEAN', 3);

  await runtime.withSystem((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO "Record" ("id","workspaceId","objectTypeId","values","createdAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, $2,
              jsonb_build_object($3::text, 'Widget ' || lpad(g::text, 6, '0'), $4::text, (g % 997), $5::text, (ARRAY['gold','silver','bronze'])[1 + (g % 3)], $6::text, (g % 2 = 0)),
              now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
       FROM generate_series(1, 100000) g`,
      ws.id,
      widget.id,
      name.id,
      qty.id,
      tier.id,
      active.id,
    ),
  );

  const deal = await runtime.withSystem((db) =>
    db.objectType.findFirstOrThrow({ where: { workspaceId: ws.id, apiSlug: 'deal' } }),
  );
  const dealName = await runtime.withSystem((db) =>
    db.attribute.findFirstOrThrow({ where: { objectTypeId: deal.id, apiSlug: 'name' } }),
  );
  const pipeline = await runtime.withSystem((db) =>
    db.list.findFirstOrThrow({ where: { workspaceId: ws.id, kind: 'PIPELINE' } }),
  );
  for (let i = 0; i < 6; i++) {
    const r = await runtime.withSystem((db) =>
      db.record.create({
        data: {
          workspaceId: ws.id,
          objectTypeId: deal.id,
          values: { [dealName.id]: `Deal ${i + 1}` },
        },
      }),
    );
    await runtime.withSystem((db) =>
      db.listEntry.create({
        data: {
          workspaceId: ws.id,
          listId: pipeline.id,
          recordId: r.id,
          stage: i < 3 ? 'lead' : 'qualified',
          position: (i + 1) * 1024,
          values: { enteredStageAt: new Date(Date.now() - i * 5 * 86_400_000).toISOString() },
        },
      }),
    );
  }
  await seedIdentityFixtures(runtime, { workspaceId: ws.id, userId: alice.id });
  return { created: true, workspaceId: ws.id, widgetTypeId: widget.id };
}

/**
 * Phase 6 fixtures (spec §16 acceptance): "Jordan Rivera" with five channel identities and a
 * timeline spread across them, a look-alike "J. Rivera" waiting in the merge queue, and an
 * unresolved TikTok account with a history of its own.
 */
async function seedIdentityFixtures(
  runtime: TenantRuntime,
  ids: { workspaceId: string; userId: string },
): Promise<void> {
  const actor: Actor = {
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    role: 'OWNER',
    grants: [],
  };
  await runtime.withTenant(actor, async (db) => {
    const pa = await personAttributes(db);
    const attrs = await loadAttributes(db, pa.objectTypeId);
    const jordan = await createRecord(db, actor, {
      objectTypeId: pa.objectTypeId,
      attributes: attrs,
      input: { name: 'Jordan Rivera', email: 'jordan@rivera.dev', phone: '+15551230100' },
    });
    const lookalike = await createRecord(db, actor, {
      objectTypeId: pa.objectTypeId,
      attributes: attrs,
      input: { name: 'J. Rivera', title: 'Founder' },
    });
    const at = (d: string) => new Date(`2026-09-${d}T09:00:00Z`);
    const seeds: {
      platform: 'FACEBOOK' | 'INSTAGRAM' | 'X' | 'LINKEDIN' | 'TIKTOK';
      externalId: string;
      handle?: string;
      email?: string;
      phone?: string;
      method: 'EXACT_EMAIL' | 'PHONE' | 'HANDLE_MATCH' | 'MANUAL';
      confidence: number;
      day: string;
      summary: string;
      type: 'MESSAGE' | 'COMMENT' | 'MENTION';
    }[] = [
      {
        platform: 'FACEBOOK',
        externalId: 'e2e_fb_jordan',
        email: 'jordan@rivera.dev',
        method: 'EXACT_EMAIL',
        confidence: 1,
        day: '02',
        summary: 'Sent a message: “Do you ship to Canada?”',
        type: 'MESSAGE',
      },
      {
        platform: 'INSTAGRAM',
        externalId: 'e2e_ig_jordan',
        handle: 'jordan.rivera',
        method: 'HANDLE_MATCH',
        confidence: 0.85,
        day: '04',
        summary: 'Commented: “Love the new roast!”',
        type: 'COMMENT',
      },
      {
        platform: 'X',
        externalId: 'e2e_x_jordan',
        handle: 'jordan.rivera',
        method: 'HANDLE_MATCH',
        confidence: 0.85,
        day: '01',
        summary: 'Mentioned you: “@acme best espresso in town”',
        type: 'MENTION',
      },
      {
        platform: 'LINKEDIN',
        externalId: 'e2e_li_jordan',
        phone: '+15551230100',
        method: 'PHONE',
        confidence: 1,
        day: '05',
        summary: 'Sent a message: “Can we talk wholesale?”',
        type: 'MESSAGE',
      },
      {
        platform: 'TIKTOK',
        externalId: 'e2e_tt_jordan',
        handle: 'jordan.rivera',
        method: 'MANUAL',
        confidence: 1,
        day: '03',
        summary: 'Commented: “Recipe please!”',
        type: 'COMMENT',
      },
    ];
    for (const sd of seeds) {
      const idn = await upsertIdentity(db, {
        workspaceId: ids.workspaceId,
        platform: sd.platform,
        externalId: sd.externalId,
        seenAt: at(sd.day),
        handle: sd.handle ?? null,
        displayName: 'Jordan Rivera',
        email: sd.email ?? null,
        phone: sd.phone ?? null,
      });
      await emitTimelineEvent(db, {
        workspaceId: ids.workspaceId,
        dedupeKey: `e2e:${sd.externalId}`,
        type: sd.type,
        occurredAt: at(sd.day),
        identityId: idn.id,
        actorIdentityId: idn.id,
        platform: sd.platform,
        summary: sd.summary,
        payload: { kind: 'e2e' },
      });
      await linkIdentity(db, actor, {
        identityId: idn.id,
        personRecordId: jordan.id,
        method: sd.method,
        confidence: sd.confidence,
        evidence: {
          score: sd.confidence,
          signals:
            sd.method === 'EXACT_EMAIL'
              ? [
                  {
                    kind: 'EXACT_EMAIL',
                    tier: 1,
                    weight: 1,
                    method: 'EXACT_EMAIL',
                    label: 'Both have the e-mail jordan@rivera.dev',
                    left: 'jordan@rivera.dev',
                    right: 'jordan@rivera.dev',
                  },
                ]
              : sd.method === 'PHONE'
                ? [
                    {
                      kind: 'PHONE',
                      tier: 1,
                      weight: 1,
                      method: 'PHONE',
                      label: 'Both have the phone number +15551230100',
                      left: '+15551230100',
                      right: '+15551230100',
                    },
                  ]
                : sd.method === 'HANDLE_MATCH'
                  ? [
                      {
                        kind: 'HANDLE_MATCH',
                        tier: 2,
                        weight: 0.85,
                        method: 'HANDLE_MATCH',
                        label: `Same handle @jordan.rivera on ${sd.platform} and INSTAGRAM, corroborated by the display name "jordan rivera"`,
                        left: { platform: sd.platform, handle: 'jordan.rivera' },
                        right: { platform: 'INSTAGRAM', handle: 'jordan.rivera' },
                      },
                    ]
                  : [],
          ...(sd.method === 'MANUAL' ? { note: 'Linked by Alice E2E' } : {}),
        },
        confirmed: sd.method === 'MANUAL',
      });
    }
    const lookalikeIdentity = await upsertIdentity(db, {
      workspaceId: ids.workspaceId,
      platform: 'X',
      externalId: 'e2e_x_jrivera',
      seenAt: at('06'),
      handle: 'j_rivera',
      displayName: 'J. Rivera',
    });
    await linkIdentity(db, actor, {
      identityId: lookalikeIdentity.id,
      personRecordId: lookalike.id,
      method: 'MANUAL',
      confidence: 1,
      evidence: { score: 1, signals: [], note: 'Linked by Alice E2E' },
      confirmed: true,
    });
    await db.mergeSuggestion.create({
      data: {
        workspaceId: ids.workspaceId,
        leftRecordId: lookalike.id,
        rightRecordId: jordan.id,
        score: 0.4,
        signals: {
          score: 0.4,
          method: 'NAME_FUZZY',
          signals: [
            {
              kind: 'NAME_FUZZY',
              tier: 3,
              weight: 0.4,
              method: 'NAME_FUZZY',
              label: 'Names "j rivera" and "jordan rivera" are 62% similar',
              left: { name: 'j rivera' },
              right: { name: 'jordan rivera' },
            },
          ],
        },
        status: 'PENDING',
      },
    });
    const mystery = await upsertIdentity(db, {
      workspaceId: ids.workspaceId,
      platform: 'TIKTOK',
      externalId: 'e2e_tt_mystery',
      seenAt: at('07'),
      handle: 'mystery.guest',
      displayName: 'Mystery Guest',
    });
    for (const [day, summary] of [
      ['06', 'Commented: “Is this gluten free?”'],
      ['07', 'Commented: “Following for the answer”'],
    ] as const)
      await emitTimelineEvent(db, {
        workspaceId: ids.workspaceId,
        dedupeKey: `e2e:mystery:${day}`,
        type: 'COMMENT',
        occurredAt: at(day),
        identityId: mystery.id,
        actorIdentityId: mystery.id,
        platform: 'TIKTOK',
        summary,
        payload: { kind: 'e2e' },
      });
  });
}
