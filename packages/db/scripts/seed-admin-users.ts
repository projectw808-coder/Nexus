/**
 * One-off: create the initial super-admin accounts directly (bypassing the sign-up form) so the
 * first real users can log in immediately after a deploy. The password is never hardcoded here —
 * pass it as an env var so it never lands in git history:
 *   railway ssh --service worker -- sh -c \
 *     "cd /repo && SEED_ADMIN_PASSWORD='...' npx tsx packages/db/scripts/seed-admin-users.ts"
 *
 * Password hashing is duplicated from `apps/web/lib/password.ts` rather than imported — this
 * script is operational tooling for @nexus/db, and apps/web must not become a dependency of it.
 */
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createUserWithPassword,
  findUserByEmailForCredentials,
  runtime,
  tenancy,
  writeSystemAudit,
} from '../src/index.ts';

const scrypt = promisify(scryptCallback);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

const ACCOUNTS = [
  { email: 'admin1@pntcrm.xyz', name: 'Admin One' },
  { email: 'admin2@pntcrm.xyz', name: 'Admin Two' },
];
const WORKSPACE = { name: 'Pantera GP', slug: 'pantera-gp' };

async function main(): Promise<void> {
  const password = process.env['SEED_ADMIN_PASSWORD'];
  if (!password || password.length < 8) {
    throw new Error('Set SEED_ADMIN_PASSWORD (8+ chars) in the environment before running this.');
  }
  const passwordHash = await hashPassword(password);
  const userIds: string[] = [];
  for (const { email, name } of ACCOUNTS) {
    const existing = await findUserByEmailForCredentials(email);
    if (existing) {
      console.log(`user ${email} already exists (${existing.id})`);
      userIds.push(existing.id);
      continue;
    }
    const user = await createUserWithPassword({ email, passwordHash, name });
    console.log(`created user ${user.email} (${user.id})`);
    userIds.push(user.id);
  }

  const [ownerId, secondId] = userIds;
  if (!ownerId || !secondId) throw new Error('expected exactly two accounts');

  const existingWs = await runtime.withSystem((db) =>
    db.workspace.findUnique({ where: { slug: WORKSPACE.slug } }),
  );
  if (existingWs) {
    console.log(`workspace ${WORKSPACE.slug} already exists (${existingWs.id})`);
    await addOwnerIfMissing(existingWs.id, secondId);
    return;
  }

  const ws = await tenancy.createWorkspace({
    name: WORKSPACE.name,
    slug: WORKSPACE.slug,
    ownerUserId: ownerId,
    ip: null,
    userAgent: 'seed-admin-users script',
  });
  console.log(`created workspace ${ws.slug} (${ws.id}), owner ${ownerId}`);
  await addOwnerIfMissing(ws.id, secondId);
}

async function addOwnerIfMissing(workspaceId: string, userId: string): Promise<void> {
  await runtime.withSystem(async (db) => {
    const existing = await db.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (existing) {
      console.log(`membership for ${userId} already exists`);
      return;
    }
    const membership = await db.membership.create({
      data: { workspaceId, userId, role: 'OWNER', joinedAt: new Date() },
    });
    await writeSystemAudit(
      db,
      workspaceId,
      { userId, ip: null, userAgent: 'seed-admin-users script' },
      {
        action: 'member.joined',
        targetType: 'Membership',
        targetId: membership.id,
        diff: { role: 'OWNER' },
      },
    );
    console.log(`added ${userId} as OWNER of ${workspaceId}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
