/**
 * API keys and idempotency at the storage boundary (§11.2, ADR-022): the key material, the
 * scope ladder, what resolution accepts and refuses across tenants, and what an
 * `Idempotency-Key` remembers.
 */
import { NexusError } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkIdempotency, recordIdempotency, requestHashFor } from './idempotency.ts';
import {
  API_KEY_PLAINTEXT_PREFIX,
  API_KEY_PREFIX_LENGTH,
  createApiKey,
  generateApiKey,
  hasApiScope,
  hashApiKey,
  listApiKeys,
  resolveApiKeyActor,
  revokeApiKey,
} from './keys.ts';
import { createTestDatabase, type TestDatabase } from '../testing/index.ts';
import type { Actor } from '../scoped.ts';

let db: TestDatabase;
let acme: { id: string };
let globex: { id: string };
let actor: Actor;

beforeAll(async () => {
  db = await createTestDatabase();
  const alice = await db.prisma.user.create({ data: { email: 'alice@keys.test', name: 'Alice' } });
  const bob = await db.prisma.user.create({ data: { email: 'bob@keys.test', name: 'Bob' } });
  acme = await db.tenancy.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: alice.id });
  globex = await db.tenancy.createWorkspace({
    name: 'Globex',
    slug: 'globex',
    ownerUserId: bob.id,
  });
  actor = { workspaceId: acme.id, userId: alice.id, role: 'OWNER', grants: [] };
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe('generateApiKey', () => {
  it('mints a url-safe key with a recognisable, non-guessable prefix', () => {
    const k = generateApiKey();
    expect(k.plaintext).toMatch(/^nx_live_[A-Za-z0-9_-]{32}$/);
    expect(k.prefix).toBe(k.plaintext.slice(0, API_KEY_PREFIX_LENGTH));
    expect(k.prefix.startsWith(API_KEY_PLAINTEXT_PREFIX)).toBe(true);
    // The prefix is short enough to be useless on its own.
    expect(k.prefix.length).toBeLessThan(k.plaintext.length / 2);
    expect(k.hash).toBe(hashApiKey(k.plaintext));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).not.toContain(k.plaintext);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext));
    expect(seen.size).toBe(200);
  });
});

describe('the scope ladder', () => {
  it('lets WRITE imply READ and ADMIN imply both', () => {
    expect(hasApiScope(['READ'], 'READ')).toBe(true);
    expect(hasApiScope(['READ'], 'WRITE')).toBe(false);
    expect(hasApiScope(['WRITE'], 'READ')).toBe(true);
    expect(hasApiScope(['WRITE'], 'ADMIN')).toBe(false);
    expect(hasApiScope(['ADMIN'], 'READ')).toBe(true);
    expect(hasApiScope(['ADMIN'], 'WRITE')).toBe(true);
    expect(hasApiScope([], 'READ')).toBe(false);
  });
});

describe('create / list / revoke / resolve', () => {
  it('returns the plaintext exactly once and never stores it', async () => {
    const created = await db.runtime.withTenant(actor, (tx) =>
      createApiKey(tx, actor, { name: 'first', scopes: ['READ', 'WRITE'] }),
    );
    expect(created.plaintext).toMatch(/^nx_live_/);

    const rows = await db.runtime.withTenant(actor, (tx) => listApiKeys(tx, acme.id));
    const row = rows.find((r) => r.id === created.id)!;
    expect(Object.keys(row)).not.toContain('keyHash');
    expect(JSON.stringify(rows)).not.toContain(created.plaintext);

    const stored = (await db.sqlAsSuperuser('SELECT "keyHash" FROM "ApiKey" WHERE id = $1', [
      created.id,
    ])) as { keyHash: string }[];
    expect(stored[0]?.keyHash).toBe(hashApiKey(created.plaintext));
  });

  it('resolves a presented key to an API_KEY actor in its own workspace', async () => {
    const created = await db.runtime.withTenant(actor, (tx) =>
      createApiKey(tx, actor, { name: 'resolve', scopes: ['WRITE'], rateLimitPerMinute: 42 }),
    );
    const resolved = await resolveApiKeyActor(db.runtime, created.plaintext);
    expect(resolved).not.toBeNull();
    expect(resolved).toMatchObject({
      workspaceId: acme.id,
      apiKeyId: created.id,
      scopes: ['WRITE'],
      rateLimitPerMinute: 42,
    });
    expect(resolved!.actor).toEqual({
      workspaceId: acme.id,
      userId: null,
      role: 'OWNER',
      grants: [],
      actorType: 'API_KEY',
      actorRef: created.id,
    });

    // Best-effort lastUsedAt, written outside the caller's transaction.
    const rows = await db.runtime.withTenant(actor, (tx) => listApiKeys(tx, acme.id));
    expect(rows.find((r) => r.id === created.id)!.lastUsedAt).not.toBeNull();
  });

  it('refuses a malformed, unknown, revoked or expired key', async () => {
    expect(await resolveApiKeyActor(db.runtime, 'not-a-key')).toBeNull();
    expect(await resolveApiKeyActor(db.runtime, `nx_live_${'z'.repeat(32)}`)).toBeNull();
    // Right shape, wrong length: rejected before it ever reaches the database.
    expect(await resolveApiKeyActor(db.runtime, `nx_live_${'z'.repeat(8)}`)).toBeNull();

    const revoked = await db.runtime.withTenant(actor, (tx) =>
      createApiKey(tx, actor, { name: 'revoked', scopes: ['READ'] }),
    );
    await db.runtime.withTenant(actor, (tx) => revokeApiKey(tx, revoked.id));
    expect(await resolveApiKeyActor(db.runtime, revoked.plaintext)).toBeNull();

    const expired = await db.runtime.withTenant(actor, (tx) =>
      createApiKey(tx, actor, {
        name: 'expired',
        scopes: ['READ'],
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    expect(await resolveApiKeyActor(db.runtime, expired.plaintext)).toBeNull();
  });

  it('keeps one workspace’s keys out of another’s list', async () => {
    const bobActor: Actor = { workspaceId: globex.id, userId: null, role: 'OWNER', grants: [] };
    const mine = await db.runtime.withTenant(actor, (tx) =>
      createApiKey(tx, actor, { name: 'acme only', scopes: ['READ'] }),
    );
    const theirs = await db.runtime.withTenant(bobActor, (tx) => listApiKeys(tx, globex.id));
    expect(theirs.some((k) => k.id === mine.id)).toBe(false);
    // A key resolves to the workspace that owns it, never to the caller's.
    expect((await resolveApiKeyActor(db.runtime, mine.plaintext))?.workspaceId).toBe(acme.id);
  });
});

describe('idempotency', () => {
  const ref = (key: string, hash: string) => ({
    workspaceId: acme.id,
    apiKeyId: null,
    key,
    requestHash: hash,
  });

  it('remembers a response and replays it for the identical request', async () => {
    const hash = requestHashFor({ method: 'POST', path: '/v1/x', body: '{"a":1}' });
    const r = ref('idem-1', hash);
    expect(await db.runtime.withTenant(actor, (tx) => checkIdempotency(tx, r))).toBeNull();
    await db.runtime.withTenant(actor, (tx) => recordIdempotency(tx, r, 201, { id: 'abc' }));
    expect(await db.runtime.withTenant(actor, (tx) => checkIdempotency(tx, r))).toEqual({
      status: 201,
      body: { id: 'abc' },
    });
  });

  it('refuses the same key with a different request', async () => {
    const r = ref('idem-2', requestHashFor({ method: 'POST', path: '/v1/x', body: '{"a":1}' }));
    await db.runtime.withTenant(actor, (tx) => recordIdempotency(tx, r, 201, { id: 'abc' }));
    const different = ref(
      'idem-2',
      requestHashFor({ method: 'POST', path: '/v1/x', body: '{"a":2}' }),
    );
    await expect(
      db.runtime.withTenant(actor, (tx) => checkIdempotency(tx, different)),
    ).rejects.toSatisfy((e: unknown) => NexusError.is(e) && e.code === 'CONFLICT');
  });

  it('hashes the method, the path and the exact body', () => {
    const base = { method: 'POST', path: '/v1/x', body: '{"a":1}' };
    expect(requestHashFor(base)).toBe(requestHashFor({ ...base, method: 'post' }));
    expect(requestHashFor(base)).not.toBe(requestHashFor({ ...base, path: '/v1/y' }));
    expect(requestHashFor(base)).not.toBe(requestHashFor({ ...base, body: '{"a":1} ' }));
  });

  it('lets a concurrent duplicate lose the unique race without throwing', async () => {
    const r = ref('idem-3', requestHashFor({ method: 'POST', path: '/v1/x', body: '{}' }));
    await db.runtime.withTenant(actor, (tx) => recordIdempotency(tx, r, 200, { ok: true }));
    await expect(
      db.runtime.withTenant(actor, (tx) => recordIdempotency(tx, r, 200, { ok: true })),
    ).resolves.toBeUndefined();
  });
});
