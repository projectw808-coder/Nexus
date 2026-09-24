/**
 * Test harness for the tRPC layer: an in-process caller wired to a PGlite database, a memory
 * mail provider and a fake session. No HTTP, no Auth.js.
 */
import type { Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { MemoryMailProvider } from '@/lib/mail/provider';
import { appRouter } from './routers';
import { createCallerFactory, type Context, type SessionUser } from './trpc';

export type Seed = {
  db: TestDatabase;
  mail: MemoryMailProvider;
  users: { alice: SessionUser; bob: SessionUser; carol: SessionUser };
  /** Alice owns Acme; Bob owns Globex; Carol is a VIEWER in Acme. */
  acme: { id: string; slug: string };
  globex: { id: string; slug: string };
  caller(session: SessionUser | null, slug: string | null): Caller;
  actorFor(session: SessionUser, workspaceId: string, role: Actor['role']): Actor;
};

const callerFactory = createCallerFactory(appRouter);
export type Caller = ReturnType<typeof callerFactory>;

export async function seedWorkspaces(): Promise<Seed> {
  const db = await createTestDatabase();
  const mail = new MemoryMailProvider();
  const mk = async (email: string, name: string): Promise<SessionUser> => {
    const u = await db.prisma.user.create({ data: { email, name } });
    return { id: u.id, email: u.email, name: u.name };
  };
  const alice = await mk('alice@acme.test', 'Alice');
  const bob = await mk('bob@globex.test', 'Bob');
  const carol = await mk('carol@acme.test', 'Carol');
  const acme = await db.tenancy.createWorkspace({
    name: 'Acme',
    slug: 'acme',
    ownerUserId: alice.id,
  });
  const globex = await db.tenancy.createWorkspace({
    name: 'Globex',
    slug: 'globex',
    ownerUserId: bob.id,
  });
  await db.runtime.withSystem((s) =>
    s.membership.create({
      data: { workspaceId: acme.id, userId: carol.id, role: 'VIEWER', joinedAt: new Date() },
    }),
  );

  const caller: Seed['caller'] = (session, slug) => {
    const ctx: Context = {
      session,
      slug,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      runtime: db.runtime,
      tenancy: db.tenancy,
      mail,
      appUrl: 'http://localhost:3000',
    };
    return callerFactory(ctx);
  };

  return {
    db,
    mail,
    users: { alice, bob, carol },
    acme,
    globex,
    caller,
    actorFor: (session, workspaceId, role) => ({
      workspaceId,
      userId: session.id,
      role,
      grants: [],
    }),
  };
}

/** Flatten the router into `path → { type }` so tests can iterate every procedure. */
export function procedureManifest(): {
  path: string;
  type: 'query' | 'mutation' | 'subscription';
}[] {
  const procs = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: 'query' | 'mutation' | 'subscription' } }
  >;
  return Object.entries(procs).map(([path, p]) => ({ path, type: p._def.type }));
}

/** Call a procedure by dotted path on a caller. */
export async function callPath(caller: unknown, path: string, input: unknown): Promise<unknown> {
  let node: unknown = caller;
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  return (node as (i: unknown) => Promise<unknown>)(input);
}
