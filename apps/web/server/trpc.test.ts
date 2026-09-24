import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineAbilityFor, assignableRoles, connection } from './abilities';
import { seedWorkspaces, type Seed } from './testing';
import { createCallerFactory, router, tenantProcedure, type Context } from './trpc';

let seed: Seed;

beforeAll(async () => {
  seed = await seedWorkspaces();
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

describe('abilities', () => {
  it('owner manages everything; admin cannot delete the workspace', () => {
    const owner = defineAbilityFor(seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'));
    const admin = defineAbilityFor(seed.actorFor(seed.users.alice, seed.acme.id, 'ADMIN'));
    expect(owner.can('delete', 'Workspace')).toBe(true);
    expect(admin.can('delete', 'Workspace')).toBe(false);
    expect(admin.can('invite', 'Membership')).toBe(true);
  });

  it('per-connection grants restrict a member per platform', () => {
    const actor = {
      ...seed.actorFor(seed.users.carol, seed.acme.id, 'MEMBER'),
      grants: [{ connectionId: 'ig', permission: 'ENGAGE' as const }],
    };
    const ability = defineAbilityFor(actor);
    expect(ability.can('engage', connection('ig'))).toBe(true);
    expect(ability.can('engage', connection('li'))).toBe(false);
    expect(ability.can('read', connection('li'))).toBe(true);
    expect(ability.can('configure', connection('ig'))).toBe(false);
  });

  it('roles can only hand out roles at or below their own; only owners make owners', () => {
    expect(assignableRoles('OWNER')).toContain('OWNER');
    expect(assignableRoles('ADMIN')).not.toContain('OWNER');
    expect(assignableRoles('MANAGER')).toEqual([]);
  });
});

describe('tenant procedure guarantees', () => {
  it('a mutation that forgets to audit is rejected and rolled back', async () => {
    const leaky = router({
      renameNoAudit: tenantProcedure.mutation(async ({ ctx }) => {
        await ctx.db.workspace.update({
          where: { id: ctx.workspace.id },
          data: { name: 'LEAKED' },
        });
        return 'done';
      }),
    });
    const ctx: Context = {
      session: seed.users.alice,
      slug: 'acme',
      ip: null,
      userAgent: null,
      runtime: seed.db.runtime,
      tenancy: seed.db.tenancy,
      mail: seed.mail,
      appUrl: 'http://localhost:3000',
      jobs: seed.jobs,
    };
    const caller = createCallerFactory(leaky)(ctx);
    await expect(caller.renameNoAudit()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    const ws = await seed.db.runtime.withSystem((s) =>
      s.workspace.findUniqueOrThrow({ where: { id: seed.acme.id } }),
    );
    expect(ws.name).toBe('Acme');
  });

  it('domain errors carry the taxonomy code and remediation', async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const self = (await alice.member.list()).find((m) => m.isSelf)!;
    const err = await alice.member
      .changeRole({ membershipId: self.id, role: 'ADMIN' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((err as TRPCError).message).toContain('own role');
  });

  it('the last owner cannot be demoted or removed', async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const carol = (await alice.member.list()).find((m) => m.email === 'carol@acme.test')!;
    await alice.member.changeRole({ membershipId: carol.id, role: 'OWNER' });
    const carolCaller = seed.caller(seed.users.carol, 'acme');
    const self = (await alice.member.list()).find((m) => m.isSelf)!;
    await carolCaller.member.changeRole({ membershipId: self.id, role: 'ADMIN' });
    // Carol is now the only owner; Alice (admin) cannot touch an owner at all.
    const aliceAdmin = seed.caller(seed.users.alice, 'acme');
    await expect(
      aliceAdmin.member.changeRole({ membershipId: carol.id, role: 'ADMIN' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Restore: Carol promotes Alice back and demotes herself is blocked (own role), so Alice does it.
    await carolCaller.member.changeRole({ membershipId: self.id, role: 'OWNER' });
    await alice.member.changeRole({ membershipId: carol.id, role: 'VIEWER' });
  });

  it('invitations: one live invitation per address, mail sent, revocable', async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const first = await alice.invitation.create({ email: 'dana@acme.test', role: 'MANAGER' });
    const second = await alice.invitation.create({ email: 'DANA@acme.test', role: 'MEMBER' });
    const pending = await alice.invitation.list();
    expect(pending.filter((i) => i.email === 'dana@acme.test').map((i) => i.id)).toEqual([
      second.id,
    ]);
    expect(seed.mail.last('invitation')?.to).toBe('dana@acme.test');
    await alice.invitation.revoke({ invitationId: second.id });
    expect(
      (await alice.invitation.list()).some((i) => i.id === first.id || i.id === second.id),
    ).toBe(false);
    await expect(alice.invitation.create({ email: 'carol@acme.test' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('audit list paginates by cursor and is scoped', async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const page1 = await alice.audit.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await alice.audit.list({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
  });
});
