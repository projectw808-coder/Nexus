import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { writeAudit } from './audit.ts';
import { type Actor, TenantScopeError, scopeArgs } from './scoped.ts';
import { generateToken, hashToken } from './tenancy.ts';
import { createTestDatabase, type TestDatabase } from './testing/pglite.ts';

let db: TestDatabase;
let userA: string;
let userB: string;
let wsA: { id: string; slug: string };
let wsB: { id: string; slug: string };
let actorA: Actor;
let actorB: Actor;

beforeAll(async () => {
  db = await createTestDatabase();
  const a = await db.prisma.user.create({ data: { email: 'alice@a.test', name: 'Alice' } });
  const b = await db.prisma.user.create({ data: { email: 'bob@b.test', name: 'Bob' } });
  userA = a.id;
  userB = b.id;
  wsA = await db.tenancy.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: userA });
  wsB = await db.tenancy.createWorkspace({ name: 'Globex', slug: 'globex', ownerUserId: userB });
  actorA = { workspaceId: wsA.id, userId: userA, role: 'OWNER', grants: [] };
  actorB = { workspaceId: wsB.id, userId: userB, role: 'OWNER', grants: [] };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('scopeArgs (pure rewrite)', () => {
  const ws = 'ws-1';

  it('ANDs workspaceId into filter reads and bulk writes', () => {
    expect(scopeArgs('Membership', 'findMany', { where: { role: 'ADMIN' } }, ws)).toEqual({
      where: { AND: [{ role: 'ADMIN' }, { workspaceId: ws }] },
    });
    expect(scopeArgs('Membership', 'deleteMany', undefined, ws)).toEqual({
      where: { AND: [{}, { workspaceId: ws }] },
    });
  });

  it('adds workspaceId as a top-level filter on unique-where operations', () => {
    expect(scopeArgs('Membership', 'findUnique', { where: { id: 'm1' } }, ws)).toEqual({
      where: { id: 'm1', workspaceId: ws },
    });
    expect(() =>
      scopeArgs(
        'Membership',
        'update',
        { where: { id: 'm1', workspaceId: 'other' }, data: {} },
        ws,
      ),
    ).toThrow(TenantScopeError);
  });

  it('never defaults workspaceId on create; throws on missing or mismatched', () => {
    expect(() => scopeArgs('Team', 'create', { data: { name: 'x' } }, ws)).toThrow(
      /required on create/,
    );
    expect(() =>
      scopeArgs('Team', 'create', { data: { name: 'x', workspaceId: 'other' } }, ws),
    ).toThrow(/does not match/);
    expect(scopeArgs('Team', 'create', { data: { name: 'x', workspaceId: ws } }, ws)).toEqual({
      data: { name: 'x', workspaceId: ws },
    });
    expect(
      scopeArgs('Team', 'create', { data: { name: 'x', workspace: { connect: { id: ws } } } }, ws),
    ).toBeTruthy();
    expect(() =>
      scopeArgs(
        'Team',
        'createMany',
        { data: [{ name: 'a', workspaceId: ws }, { name: 'b' }] },
        ws,
      ),
    ).toThrow(TenantScopeError);
  });

  it('scopes list relations in include/select and relation filters in where', () => {
    const out = scopeArgs(
      'Workspace',
      'findUnique',
      { where: { id: ws }, include: { memberships: true, teams: { include: { members: true } } } },
      ws,
    );
    expect(out).toEqual({
      where: { id: ws },
      include: {
        memberships: { where: { AND: [{}, { workspaceId: ws }] } },
        teams: {
          where: { AND: [{}, { workspaceId: ws }] },
          include: { members: { where: { AND: [{}, { workspaceId: ws }] } } },
        },
      },
    });
    const filtered = scopeArgs(
      'User',
      'findMany',
      { where: { memberships: { some: { role: 'ADMIN' } } } },
      ws,
    );
    expect(filtered).toEqual({
      where: { memberships: { some: { AND: [{ role: 'ADMIN' }, { workspaceId: ws }] } } },
    });
  });

  it('refuses to reach or create another workspace', () => {
    expect(() => scopeArgs('Workspace', 'findUnique', { where: { id: 'other' } }, ws)).toThrow(
      TenantScopeError,
    );
    expect(() =>
      scopeArgs('Workspace', 'create', { data: { name: 'x', slug: 'x', region: 'eu' } }, ws),
    ).toThrow(/createWorkspace/);
    expect(scopeArgs('Workspace', 'findMany', {}, ws)).toEqual({
      where: { AND: [{}, { id: ws }] },
    });
  });

  it('scopes nested writes', () => {
    const out = scopeArgs(
      'Team',
      'update',
      {
        where: { id: 't1' },
        data: { members: { deleteMany: { userId: 'u9' } } },
      },
      ws,
    );
    expect(out).toEqual({
      where: { id: 't1', workspaceId: ws },
      data: { members: { deleteMany: { AND: [{ userId: 'u9' }, { workspaceId: ws }] } } },
    });
    expect(() =>
      scopeArgs(
        'Team',
        'update',
        { where: { id: 't1' }, data: { members: { create: { userId: 'u1', role: 'x' } } } },
        ws,
      ),
    ).toThrow(/required on create/);
  });
});

describe('withTenant against Postgres (PGlite)', () => {
  it('sees only its own workspace rows', async () => {
    const mine = await db.runtime.withTenant(actorA, (t) => t.membership.findMany());
    expect(mine.map((m) => m.workspaceId)).toEqual([wsA.id]);
    const count = await db.runtime.withTenant(actorB, (t) => t.membership.count());
    expect(count).toBe(1);
  });

  it('cannot fetch another tenant row by id', async () => {
    const bMembership = await db.runtime.withSystem((s) =>
      s.membership.findFirstOrThrow({ where: { workspaceId: wsB.id } }),
    );
    const got = await db.runtime.withTenant(actorA, (t) =>
      t.membership.findUnique({ where: { id: bMembership.id } }),
    );
    expect(got).toBeNull();
    await expect(
      db.runtime.withTenant(actorA, (t) =>
        t.membership.update({ where: { id: bMembership.id }, data: { role: 'VIEWER' } }),
      ),
    ).rejects.toThrow();
    const stillOwner = await db.runtime.withSystem((s) =>
      s.membership.findUniqueOrThrow({ where: { id: bMembership.id } }),
    );
    expect(stillOwner.role).toBe('OWNER');
  });

  it('cannot write a row into another workspace', async () => {
    await expect(
      db.runtime.withTenant(actorA, (t) =>
        t.team.create({ data: { workspaceId: wsB.id, name: 'smuggled' } }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it('RLS blocks a deliberately unscoped query at the database level', async () => {
    // No tenant transaction: app.workspace_id is unset, so the policy matches nothing.
    const rows = await db.sql('SELECT id FROM "Membership"');
    expect(rows).toEqual([]);
    const truth = (await db.sqlAsSuperuser('SELECT count(*)::int AS n FROM "Membership"')) as {
      n: number;
    }[];
    expect(truth[0]?.n).toBe(2);
    // Inside A's transaction a raw insert for B is rejected by WITH CHECK.
    await expect(
      db.runtime.withTenant(
        actorA,
        (t) =>
          t.$executeRaw`INSERT INTO "Team" ("id","workspaceId","name","updatedAt") VALUES ('t-smuggle', ${wsB.id}, 'x', now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('withSystem sees across workspaces', async () => {
    const all = await db.runtime.withSystem((s) => s.membership.count());
    expect(all).toBe(2);
  });

  it('scopes relation traversal deep inside include', async () => {
    // Alice joins Globex too, so User → memberships would otherwise leak B into an A query.
    await db.runtime.withSystem((s) =>
      s.membership.create({
        data: { workspaceId: wsB.id, userId: userA, role: 'VIEWER', joinedAt: new Date() },
      }),
    );
    const ws = await db.runtime.withTenant(actorA, (t) =>
      t.workspace.findUniqueOrThrow({
        where: { id: wsA.id },
        include: { memberships: { include: { user: { include: { memberships: true } } } } },
      }),
    );
    const nested = ws.memberships.flatMap((m) => m.user.memberships.map((x) => x.workspaceId));
    expect(nested).toEqual([wsA.id]);
    await db.runtime.withSystem((s) =>
      s.membership.deleteMany({ where: { workspaceId: wsB.id, userId: userA } }),
    );
  });

  it('audit rows land in the same transaction and roll back with it', async () => {
    await expect(
      db.runtime.withTenant(actorA, async (t, ctx) => {
        await writeAudit(t, ctx.actor, {
          action: 'test.rollback',
          targetType: 'Team',
          targetId: 'x',
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const n = await db.runtime.withSystem((s) =>
      s.auditLog.count({ where: { action: 'test.rollback' } }),
    );
    expect(n).toBe(0);
  });
});

describe('invitations', () => {
  it('accepts an invitation for the matching email, once', async () => {
    const raw = generateToken();
    const inv = await db.runtime.withTenant(actorA, (t) =>
      t.invitation.create({
        data: {
          workspaceId: wsA.id,
          email: 'Bob@B.test',
          role: 'MEMBER',
          tokenHash: hashToken(raw),
          invitedById: userA,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );
    expect((await db.tenancy.previewInvitation(raw)).ok).toBe(true);

    await expect(
      db.tenancy.acceptInvitation({ userId: userA, userEmail: 'alice@a.test', rawToken: raw }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const res = await db.tenancy.acceptInvitation({
      userId: userB,
      userEmail: 'bob@b.test',
      rawToken: raw,
    });
    expect(res.slug).toBe('acme');
    const m = await db.runtime.withSystem((s) =>
      s.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: wsA.id, userId: userB } },
      }),
    );
    expect(m?.role).toBe('MEMBER');
    const audit = await db.runtime.withSystem((s) =>
      s.auditLog.findFirst({ where: { workspaceId: wsA.id, action: 'invitation.accepted' } }),
    );
    expect(audit?.diff).toMatchObject({ invitationId: inv.id });

    await expect(
      db.tenancy.acceptInvitation({ userId: userB, userEmail: 'bob@b.test', rawToken: raw }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const unknown = await db.tenancy
      .acceptInvitation({ userId: userB, userEmail: 'bob@b.test', rawToken: 'nope' })
      .catch((e: unknown) => e);
    expect(NexusError.is(unknown) && unknown.code).toBe('NOT_FOUND');
  });

  it('lists workspaces per user and resolves actors with roles', async () => {
    const list = await db.tenancy.listWorkspacesForUser(userB);
    expect(list.map((w) => [w.slug, w.role])).toEqual([
      ['globex', 'OWNER'],
      ['acme', 'MEMBER'],
    ]);
    const actor = await db.tenancy.resolveActor(userB, 'acme');
    expect(actor?.role).toBe('MEMBER');
    expect(await db.tenancy.resolveActor(userB, 'nowhere')).toBeNull();
  });
});
