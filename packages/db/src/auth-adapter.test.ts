import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthAdapter, type AuthAdapter } from './auth-adapter.ts';
import { createTestDatabase, type TestDatabase } from './testing/pglite.ts';

let db: TestDatabase;
let adapter: AuthAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  adapter = createAuthAdapter(db.prisma);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('authAdapter image ↔ avatarUrl', () => {
  it('stores Auth.js `image` in the avatarUrl column and reads it back as `image`', async () => {
    const created = await adapter.createUser!({
      id: 'ignored-by-adapter',
      email: 'ada@example.com',
      emailVerified: null,
      name: 'Ada',
      image: 'https://cdn.example.com/ada.png',
    });
    expect(created.image).toBe('https://cdn.example.com/ada.png');
    expect(created).not.toHaveProperty('avatarUrl');

    const row = await db.prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.avatarUrl).toBe('https://cdn.example.com/ada.png');

    const byId = await adapter.getUser!(created.id);
    expect(byId?.image).toBe('https://cdn.example.com/ada.png');
    expect(byId).not.toHaveProperty('avatarUrl');

    // citext: lookups are case-insensitive, and the adapter still translates the column.
    const byEmail = await adapter.getUserByEmail!('ADA@example.com');
    expect(byEmail?.id).toBe(created.id);
    expect(byEmail?.image).toBe('https://cdn.example.com/ada.png');
  });

  it('updates image through avatarUrl and leaves it alone when image is not provided', async () => {
    const created = await adapter.createUser!({
      id: 'x',
      email: 'grace@example.com',
      emailVerified: null,
      name: 'Grace',
      image: null,
    });

    const renamed = await adapter.updateUser!({ id: created.id, name: 'Grace H.' });
    expect(renamed.name).toBe('Grace H.');
    expect(renamed.image).toBeNull();

    const withAvatar = await adapter.updateUser!({
      id: created.id,
      image: 'https://cdn.example.com/grace.png',
    });
    expect(withAvatar.image).toBe('https://cdn.example.com/grace.png');
    const row = await db.prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.avatarUrl).toBe('https://cdn.example.com/grace.png');
  });

  it('maps the user inside getSessionAndUser and getUserByAccount', async () => {
    const user = await adapter.createUser!({
      id: 'x',
      email: 'linus@example.com',
      emailVerified: null,
      name: null,
      image: 'https://cdn.example.com/linus.png',
    });
    await adapter.linkAccount!({
      userId: user.id,
      type: 'oauth',
      provider: 'google',
      providerAccountId: 'g-1',
    });
    const byAccount = await adapter.getUserByAccount!({
      provider: 'google',
      providerAccountId: 'g-1',
    });
    expect(byAccount?.image).toBe('https://cdn.example.com/linus.png');

    await adapter.createSession!({
      sessionToken: 'tok-1',
      userId: user.id,
      expires: new Date(Date.now() + 60_000),
    });
    const found = await adapter.getSessionAndUser!('tok-1');
    expect(found?.session.sessionToken).toBe('tok-1');
    expect(found?.user.image).toBe('https://cdn.example.com/linus.png');
    expect(found?.user).not.toHaveProperty('avatarUrl');
  });
});
