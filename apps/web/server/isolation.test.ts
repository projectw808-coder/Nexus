/**
 * Phase 1 acceptance, generated from the router manifest so a new route cannot be forgotten:
 *
 *  1. Cross-tenant isolation: a user who is not a member of workspace A gets NOT_FOUND on every
 *     tenant procedure addressed to A, and a member of B addressing B with A's ids gets
 *     NOT_FOUND — never A's data.
 *  2. A `viewer` cannot mutate anything.
 *  3. Every mutation writes an audit row.
 *
 * Every procedure must have an entry in FIXTURES; the first test fails otherwise.
 */
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callPath, procedureManifest, seedWorkspaces, type Seed } from './testing';

type Tier = 'public' | 'user' | 'tenant';
type Fixture = {
  tier: Tier;
  /** Valid input for the owner of Acme; `ids` are Acme's rows, refreshed before each call. */
  input: (ids: Ids) => unknown;
  /** Input that references Acme rows but is sent to Globex (cross-tenant by id). */
  crossInput?: (ids: Ids) => unknown;
  /** Reason a user-tier mutation writes its audit row inside packages/db instead of ctx.audit. */
  auditedBy?: 'tenancy';
};

type Ids = {
  carolMembershipId: string;
  invitationId: string;
  auditCursor: string | undefined;
};

const FIXTURES: Record<string, Fixture> = {
  'me.get': { tier: 'user', input: () => undefined },
  'workspace.list': { tier: 'user', input: () => undefined },
  'workspace.create': {
    tier: 'user',
    input: () => ({ name: 'Initech', slug: `initech-${Date.now()}` }),
    auditedBy: 'tenancy',
  },
  'workspace.current': { tier: 'tenant', input: () => undefined },
  'workspace.update': { tier: 'tenant', input: () => ({ name: 'Acme Corp' }) },
  'member.list': { tier: 'tenant', input: () => undefined },
  'member.changeRole': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
  },
  'member.remove': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId }),
  },
  'invitation.list': { tier: 'tenant', input: () => undefined },
  'invitation.create': {
    tier: 'tenant',
    input: () => ({ email: `new-${Date.now()}@acme.test`, role: 'MEMBER' }),
  },
  'invitation.revoke': {
    tier: 'tenant',
    input: (ids) => ({ invitationId: ids.invitationId }),
    crossInput: (ids) => ({ invitationId: ids.invitationId }),
  },
  'invitation.preview': { tier: 'public', input: () => ({ token: 'x'.repeat(32) }) },
  'invitation.accept': {
    tier: 'user',
    input: () => ({ token: 'x'.repeat(32) }),
    auditedBy: 'tenancy',
  },
  'audit.list': { tier: 'tenant', input: (ids) => ({ limit: 10, cursor: ids.auditCursor }) },
};

let seed: Seed;

async function freshIds(): Promise<Ids> {
  // Re-seed the rows mutations consume so each test starts from a known state.
  const carol = await seed.db.runtime.withSystem(async (s) => {
    const m = await s.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: seed.acme.id, userId: seed.users.carol.id } },
    });
    return m
      ? s.membership.update({ where: { id: m.id }, data: { deletedAt: null, role: 'VIEWER' } })
      : s.membership.create({
          data: { workspaceId: seed.acme.id, userId: seed.users.carol.id, role: 'VIEWER' },
        });
  });
  const owner = seed.caller(seed.users.alice, 'acme');
  const inv = await owner.invitation.create({
    email: `pending-${Date.now()}-${Math.random()}@acme.test`,
    role: 'VIEWER',
  });
  return { carolMembershipId: carol.id, invitationId: inv.id, auditCursor: undefined };
}

const codeOf = (e: unknown): string =>
  e instanceof TRPCError ? e.code : `not-a-TRPCError: ${String(e)}`;

beforeAll(async () => {
  seed = await seedWorkspaces();
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

describe('router manifest', () => {
  it('every procedure has an isolation fixture', () => {
    const missing = procedureManifest()
      .map((p) => p.path)
      .filter((p) => !(p in FIXTURES));
    expect(missing, `add fixtures in server/isolation.test.ts for: ${missing.join(', ')}`).toEqual(
      [],
    );
    const stale = Object.keys(FIXTURES).filter(
      (p) => !procedureManifest().some((m) => m.path === p),
    );
    expect(stale, `fixtures for removed procedures: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('cross-tenant isolation', () => {
  const tenantProcs = () => procedureManifest().filter((p) => FIXTURES[p.path]?.tier === 'tenant');

  it('a non-member addressing workspace A gets NOT_FOUND on every tenant procedure', async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const bobOnAcme = seed.caller(seed.users.bob, 'acme');
      const result = await callPath(bobOnAcme, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('NOT_FOUND');
    }
  });

  it("a member of B using A's ids gets NOT_FOUND, and A is untouched", async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const fx = FIXTURES[p.path]!;
      if (!fx.crossInput) continue;
      const bobOnGlobex = seed.caller(seed.users.bob, 'globex');
      const result = await callPath(bobOnGlobex, p.path, fx.crossInput(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('NOT_FOUND');
    }
    const carol = await seed.db.runtime.withSystem((s) =>
      s.membership.findUniqueOrThrow({ where: { id: ids.carolMembershipId } }),
    );
    expect(carol.deletedAt).toBeNull();
    expect(carol.role).toBe('VIEWER');
  });

  it('an anonymous caller gets UNAUTHORIZED on user and tenant procedures', async () => {
    const ids = await freshIds();
    for (const p of procedureManifest()) {
      const fx = FIXTURES[p.path]!;
      if (fx.tier === 'public') continue;
      const anon = seed.caller(null, 'acme');
      const result = await callPath(anon, p.path, fx.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('UNAUTHORIZED');
    }
  });

  it("tenant reads never return another workspace's rows", async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const members = await alice.member.list();
    expect(members.every((m) => ['alice@acme.test', 'carol@acme.test'].includes(m.email))).toBe(
      true,
    );
    const audit = await alice.audit.list({ limit: 100 });
    const ids = new Set(audit.items.map((i) => i.id));
    const globexRows = await seed.db.runtime.withSystem((s) =>
      s.auditLog.findMany({ where: { workspaceId: seed.globex.id } }),
    );
    expect(globexRows.length).toBeGreaterThan(0);
    for (const r of globexRows) expect(ids.has(r.id)).toBe(false);
  });
});

describe('a viewer cannot mutate anything', () => {
  it('every tenant mutation returns FORBIDDEN for a VIEWER', async () => {
    const ids = await freshIds();
    const mutations = procedureManifest().filter(
      (p) => p.type === 'mutation' && FIXTURES[p.path]?.tier === 'tenant',
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const p of mutations) {
      const carol = seed.caller(seed.users.carol, 'acme');
      const result = await callPath(carol, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('FORBIDDEN');
    }
  });

  it('a viewer can still read', async () => {
    const carol = seed.caller(seed.users.carol, 'acme');
    expect((await carol.workspace.current()).role).toBe('VIEWER');
    expect((await carol.member.list()).length).toBeGreaterThan(0);
  });
});

describe('every mutation writes an audit row', () => {
  it('for each mutation, the AuditLog grows inside the same call', async () => {
    const mutations = procedureManifest().filter((p) => p.type === 'mutation');
    for (const p of mutations) {
      const fx = FIXTURES[p.path]!;
      const ids = await freshIds();
      const before = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      const owner = seed.caller(seed.users.alice, fx.tier === 'tenant' ? 'acme' : null);
      if (p.path === 'invitation.accept') {
        // Needs a real token for Bob; create one as Alice and accept as Bob.
        const raw = await inviteBob();
        await seed.caller(seed.users.bob, null).invitation.accept({ token: raw });
      } else {
        await callPath(owner, p.path, fx.input(ids));
      }
      const after = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      expect(after, `${p.path} wrote no audit row`).toBeGreaterThan(before);
    }
  });
});

async function inviteBob(): Promise<string> {
  const alice = seed.caller(seed.users.alice, 'acme');
  await seed.db.runtime.withSystem((s) =>
    s.membership.deleteMany({ where: { workspaceId: seed.acme.id, userId: seed.users.bob.id } }),
  );
  await alice.invitation.create({ email: seed.users.bob.email, role: 'MEMBER' });
  const sent = seed.mail.last('invitation');
  const link = sent?.text.match(/https?:\/\/\S+\/invite\/(\S+)/);
  if (!link?.[1]) throw new Error('invitation mail did not contain a link');
  return link[1];
}
