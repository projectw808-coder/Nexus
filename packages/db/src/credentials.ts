/**
 * Row access for the email+password Credentials provider (`apps/web/auth.ts`). Hashing itself
 * lives in `apps/web/lib/password.ts` — this file only ever sees an already-hashed string, never
 * a plaintext password, matching this package's rule against holding auth secrets.
 */
import { getBasePrisma } from './client.ts';

export type CredentialsUser = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
};

export async function findUserByEmailForCredentials(
  email: string,
): Promise<CredentialsUser | null> {
  const prisma = await getBasePrisma();
  return prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
}

/** Throws on a duplicate email (Prisma's unique-constraint error) — the caller maps that to a
 * user-facing "an account with this email already exists". */
export async function createUserWithPassword(params: {
  email: string;
  passwordHash: string;
  name?: string;
}): Promise<CredentialsUser> {
  const prisma = await getBasePrisma();
  const user = await prisma.user.create({
    data: {
      email: params.email,
      name: params.name,
      passwordHash: params.passwordHash,
      // Created with a password directly rather than through a magic-link click, so there is no
      // separate email-ownership proof — treat that as already established for this flow.
      emailVerified: new Date(),
    },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
  return user;
}
