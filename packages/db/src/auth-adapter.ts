/**
 * Auth.js adapter over the unscoped Prisma client. The Auth.js tables (User, Account, Session,
 * VerificationToken) are non-tenant, so this is one of the few sanctioned users of the base
 * client. Two jobs beyond what `@auth/prisma-adapter` does:
 *
 *  - Auth.js calls the avatar `image`; our column is `avatarUrl`. The two names are translated
 *    at this boundary so neither side learns the other's spelling.
 *  - The client is resolved lazily through `getBasePrisma()`, so `authAdapter()` can be called
 *    while building the Auth.js config without DATABASE_URL being needed at import time.
 */
import { PrismaAdapter } from '@auth/prisma-adapter';
import { getBasePrisma } from './client.ts';
import type { PrismaClient } from './generated/prisma/client.ts';

/**
 * `@auth/core`'s `Adapter`, reached through the adapter package so this package needs no
 * direct `@auth/core` dependency.
 */
export type AuthAdapter = ReturnType<typeof PrismaAdapter>;
type AdapterUser = Awaited<ReturnType<NonNullable<AuthAdapter['createUser']>>>;

/** What a User row really looks like when it comes back from Prisma. */
type UserRow = Omit<AdapterUser, 'image'> & { avatarUrl?: string | null };

/** Every method on `Adapter` is optional in the type; these are the ones we know PrismaAdapter provides. */
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`@auth/prisma-adapter does not implement ${name}`);
  return value;
}

/** Auth.js → Prisma: rename `image` to `avatarUrl`. Leaves `undefined` alone so the adapter's own undefined-stripping still applies. */
function toRow<T extends Partial<AdapterUser>>(user: T): T {
  if (!('image' in user)) return user;
  const { image, ...rest } = user;
  // The result carries Prisma's column name; Auth.js's type has no slot for it, hence the cast.
  return { ...rest, avatarUrl: image } as unknown as T;
}

/** Prisma → Auth.js: expose `avatarUrl` as `image` and drop the column name. */
function fromRow(row: AdapterUser | null): AdapterUser | null {
  if (!row) return null;
  const { avatarUrl, ...rest } = row as UserRow;
  return { ...rest, image: avatarUrl ?? null };
}

function fromRowRequired(row: AdapterUser): AdapterUser {
  const mapped = fromRow(row);
  if (!mapped) throw new Error('expected a user row');
  return mapped;
}

/** Build the adapter around a concrete client. Exported for tests (PGlite) and for callers that already hold a client. */
export function createAuthAdapter(prisma: PrismaClient): AuthAdapter {
  const inner = PrismaAdapter(prisma);

  // Methods are invoked on `inner` (optional call) rather than detached, so `this` is preserved.
  return {
    ...inner,
    createUser: async (user) =>
      fromRowRequired(await must(inner.createUser?.(toRow(user)), 'createUser')),
    getUser: async (id) => fromRow(await must(inner.getUser?.(id), 'getUser')),
    getUserByEmail: async (email) =>
      fromRow(await must(inner.getUserByEmail?.(email), 'getUserByEmail')),
    getUserByAccount: async (account) =>
      fromRow(await must(inner.getUserByAccount?.(account), 'getUserByAccount')),
    updateUser: async (user) =>
      fromRowRequired(await must(inner.updateUser?.(toRow(user)), 'updateUser')),
    getSessionAndUser: async (sessionToken) => {
      const found = await must(inner.getSessionAndUser?.(sessionToken), 'getSessionAndUser');
      if (!found) return null;
      return { session: found.session, user: fromRowRequired(found.user) };
    },
  };
}

let ready: Promise<AuthAdapter> | undefined;

function resolveAdapter(): Promise<AuthAdapter> {
  ready ??= getBasePrisma().then(createAuthAdapter);
  return ready;
}

/**
 * The adapter methods Auth.js may call for email + OAuth sign-in with database sessions. The
 * WebAuthn (`authenticator`) methods are deliberately left out: the schema has no Authenticator
 * model, and Auth.js treats a missing method as "unsupported" rather than failing at call time.
 */
const LAZY_METHODS = [
  'createUser',
  'getUser',
  'getUserByEmail',
  'getUserByAccount',
  'updateUser',
  'deleteUser',
  'linkAccount',
  'unlinkAccount',
  'createSession',
  'getSessionAndUser',
  'updateSession',
  'deleteSession',
  'createVerificationToken',
  'useVerificationToken',
  'getAccount',
] as const satisfies readonly (keyof AuthAdapter)[];

type AnyMethod = (...args: unknown[]) => unknown;

/**
 * Adapter for the Auth.js config. Every method awaits the process-wide client on first use and
 * then delegates to {@link createAuthAdapter}, so the config can be built synchronously.
 */
export function authAdapter(): AuthAdapter {
  const lazy: Partial<Record<(typeof LAZY_METHODS)[number], AnyMethod>> = {};
  for (const name of LAZY_METHODS) {
    lazy[name] = async (...args: unknown[]) => {
      const adapter = await resolveAdapter();
      // Looked up by name and applied with `adapter` as `this`; never detached from its object.
      const fn: unknown = Reflect.get(adapter, name);
      if (typeof fn !== 'function') {
        throw new Error(`@auth/prisma-adapter does not implement ${name}`);
      }
      return (fn as AnyMethod).apply(adapter, args);
    };
  }
  return lazy as AuthAdapter;
}
