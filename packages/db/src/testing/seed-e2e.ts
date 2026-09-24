/**
 * Seeds the e2e workspace used by apps/web/e2e (ADR-012): two users, one workspace, a custom
 * "widget" object with 100k rows inserted in SQL, and a pipeline with a few deals. Idempotent.
 * Lives here because raw SQL is only allowed inside packages/db.
 */
import { createTenancy } from '../tenancy.ts';
import type { TenantRuntime } from '../scoped.ts';

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
  return { created: true, workspaceId: ws.id, widgetTypeId: widget.id };
}
