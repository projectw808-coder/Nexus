/**
 * REST v1 (§11.2, ADR-022) against the real route handlers and a real Postgres (PGlite).
 *
 * Nothing here is mocked except the platform the connector talks to: the requests go through
 * `authenticate` → the rate window → the idempotency store → the same `@nexus/db` functions the
 * tRPC routers call, and come back as the bytes a customer would receive.
 */
import {
  connectionPageSchema,
  conversationPageSchema,
  messagePageSchema,
  problemSchema,
  recordPageSchema,
  recordSchema,
  replyOutcomeSchema,
  syncRunPageSchema,
} from '@nexus/api';
import { upsertConnection } from '@nexus/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restHarness, type RestHarness } from './rest-testing';
import { seedWorkspaces, type Seed } from './testing';

/** A UUID that is guaranteed not to match `id` — flipping the last hex digit can be a no-op. */
function mangleId(id: string): string {
  const last = id.at(-1);
  return id.slice(0, -1) + (last === '0' ? '1' : '0');
}

let seed: Seed;
let rest: RestHarness;
let readWriteKey: string;
let readOnlyKey: string;
let connectionId: string;
let conversationId: string;

beforeAll(async () => {
  seed = await seedWorkspaces();
  rest = restHarness(seed);
  readWriteKey = (await rest.createKey({ name: 'rw', scopes: ['WRITE'] })).plaintext;
  readOnlyKey = (await rest.createKey({ name: 'ro', scopes: ['READ'] })).plaintext;

  const actor = seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER');
  const conn = await seed.db.runtime.withTenant(actor, async (db) => {
    const issued = seed.mockPlatform.issueToken();
    const tokenRef = (
      await seed.sync.vault.putTokenSet(db, seed.acme.id, {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        scopes: ['read:posts'],
        tokenType: 'Bearer',
        raw: {},
      })
    ).ref;
    return upsertConnection(db, {
      workspaceId: seed.acme.id,
      platform: 'MOCK',
      label: 'Mock — REST',
      accountExternalId: 'acct_rest',
      accountName: 'REST',
      scopesGranted: ['read:posts'],
      scopesRequired: ['read:posts'],
      capabilities: ['read:posts'],
      apiVersion: '2026-09',
      tokenRef,
      ownerUserId: seed.users.alice.id,
    });
  });
  connectionId = conn.id;

  // A DM with one inbound message, so the reply endpoint has a real conversation and an open
  // messaging window to preflight against (the mock connector's `write:reply_dm` capability).
  conversationId = await seed.db.runtime.withTenant(actor, async (db) => {
    const identity = await db.identity.create({
      data: {
        workspaceId: seed.acme.id,
        platform: 'MOCK',
        externalId: 'user_rest_7',
        displayName: 'User 7',
        handle: 'user7',
      },
      select: { id: true },
    });
    const conversation = await db.conversation.create({
      data: {
        workspaceId: seed.acme.id,
        connectionId: conn.id,
        platform: 'MOCK',
        kind: 'DM',
        externalId: 'dm:user_rest_7',
        identityId: identity.id,
        lastMessageAt: new Date(),
        unreadCount: 1,
      },
      select: { id: true },
    });
    await db.message.create({
      data: {
        workspaceId: seed.acme.id,
        conversationId: conversation.id,
        externalId: 'm_rest_inbound_1',
        direction: 'INBOUND',
        authorIdentityId: identity.id,
        body: 'hello?',
        attachments: [],
        sentAt: new Date(),
        deliveryState: 'DELIVERED',
        replyWindowExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return conversation.id;
  });
}, 180_000);

afterAll(async () => {
  rest?.dispose();
  await seed?.db.close();
});

describe('authentication and scopes', () => {
  it('refuses a request with no key, and says so in Problem Details', async () => {
    const res = await rest.call('GET', '/api/v1/objects');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    const problem = problemSchema.parse(res.body);
    expect(problem.code).toBe('AUTH_EXPIRED');
    expect(problem.type).toMatch(/problems\/auth-expired$/);
  });

  it('refuses an unknown, a revoked and an expired key alike', async () => {
    const bogus = await rest.call('GET', '/api/v1/objects', {
      key: `nx_live_${'a'.repeat(32)}`,
    });
    expect(bogus.status).toBe(401);

    const revoked = await rest.createKey({ name: 'revoked' });
    await seed.db.runtime.withTenant(seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'), (db) =>
      db.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } }),
    );
    expect((await rest.call('GET', '/api/v1/objects', { key: revoked.plaintext })).status).toBe(
      401,
    );

    const expired = await rest.createKey({
      name: 'expired',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await rest.call('GET', '/api/v1/objects', { key: expired.plaintext })).status).toBe(
      401,
    );
  });

  it('gives a READ-only key a 403 on a write, and lets WRITE imply READ', async () => {
    const denied = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readOnlyKey,
      body: { values: { name: 'Nope' } },
    });
    expect(denied.status).toBe(403);
    const problem = problemSchema.parse(denied.body);
    expect(problem.code).toBe('FORBIDDEN');
    expect(problem.detail).toContain('WRITE');

    // The WRITE key never lists READ, but the ladder covers it.
    expect((await rest.call('GET', '/api/v1/objects', { key: readWriteKey })).status).toBe(200);
  });

  it('records `lastUsedAt` and never exposes the hash through the management API', async () => {
    const owner = seed.caller(seed.users.alice, 'acme');
    const keys = await owner.apiKey.list();
    const rw = keys.find((k) => k.name === 'rw')!;
    expect(rw.lastUsedAt).not.toBeNull();
    expect(rw.prefix.startsWith('nx_live_')).toBe(true);
    expect(Object.keys(rw)).not.toContain('keyHash');
  });

  it('scopes every response to the key’s own workspace', async () => {
    const globexKey = await rest.createKey({
      name: 'globex',
      scopes: ['WRITE'],
      workspaceId: seed.globex.id,
    });
    const created = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { name: 'Acme Only' } },
    });
    expect(created.status).toBe(201);
    const id = recordSchema.parse(created.body).id;
    const crossTenant = await rest.call(`GET`, `/api/v1/objects/person/records/${id}`, {
      key: globexKey.plaintext,
    });
    expect(crossTenant.status).toBe(404);
  });
});

describe('key management through the app (tRPC)', () => {
  it('creates, lists and revokes, showing the plaintext exactly once', async () => {
    const owner = seed.caller(seed.users.alice, 'acme');
    const created = await owner.apiKey.create({
      name: 'managed',
      scopes: ['READ'],
      rateLimitPerMinute: 120,
    });
    expect(created.plaintext).toMatch(/^nx_live_[A-Za-z0-9_-]{32}$/);
    expect(created.prefix).toBe(created.plaintext.slice(0, 12));

    const listed = await owner.apiKey.list();
    const row = listed.find((k) => k.id === created.id)!;
    expect(row).toMatchObject({ name: 'managed', scopes: ['READ'], rateLimitPerMinute: 120 });
    // The list can never hand the secret back, only the prefix.
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
    expect(row.createdBy?.email).toBe(seed.users.alice.email);

    // The audit row records the prefix, never the key.
    const audit = await owner.audit.list({ limit: 50 });
    const entry = audit.items.find(
      (a) => a.action === 'api_key.created' && a.targetId === created.id,
    )!;
    expect(JSON.stringify(entry.diff)).toContain(created.prefix);
    expect(JSON.stringify(entry.diff)).not.toContain(created.plaintext);

    expect((await rest.call('GET', '/api/v1/objects', { key: created.plaintext })).status).toBe(
      200,
    );
    await owner.apiKey.revoke({ id: created.id });
    expect((await rest.call('GET', '/api/v1/objects', { key: created.plaintext })).status).toBe(
      401,
    );
    await expect(owner.apiKey.revoke({ id: created.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('hides keys from a role that may not read them', async () => {
    const viewer = seed.caller(seed.users.carol, 'acme');
    await expect(viewer.apiKey.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(viewer.apiKey.create({ name: 'nope', scopes: ['ADMIN'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('records CRUD and the query DSL', () => {
  it('creates, reads, patches and soft-deletes a record', async () => {
    const created = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { name: 'Ada Lovelace', email: 'ada@example.test' } },
    });
    expect(created.status).toBe(201);
    const record = recordSchema.parse(created.body);
    expect(record.label).toBe('Ada Lovelace');

    const fetched = await rest.call('GET', `/api/v1/objects/person/records/${record.id}`, {
      key: readOnlyKey,
    });
    expect(fetched.status).toBe(200);
    expect(recordSchema.parse(fetched.body).id).toBe(record.id);

    const patched = await rest.call('PATCH', `/api/v1/objects/person/records/${record.id}`, {
      key: readWriteKey,
      body: { values: { name: 'Ada King' } },
    });
    expect(patched.status).toBe(200);
    expect(recordSchema.parse(patched.body).label).toBe('Ada King');

    const deleted = await rest.call('DELETE', `/api/v1/objects/person/records/${record.id}`, {
      key: readWriteKey,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ id: record.id, deleted: true });
    expect(
      (await rest.call('GET', `/api/v1/objects/person/records/${record.id}`, { key: readOnlyKey }))
        .status,
    ).toBe(200); // soft-deleted rows are still addressable
  });

  it('rejects an unknown attribute with a 400 Problem Details', async () => {
    const res = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { not_an_attribute: 'x' } },
    });
    expect(res.status).toBe(400);
    expect(problemSchema.parse(res.body).code).toBe('VALIDATION');
  });

  it('404s an unknown object slug', async () => {
    const res = await rest.call('GET', '/api/v1/objects/nope/records', { key: readOnlyKey });
    expect(res.status).toBe(404);
    expect(problemSchema.parse(res.body).code).toBe('NOT_FOUND');
  });

  it('pages records with a cursor and caps the limit at 200', async () => {
    for (let i = 0; i < 7; i += 1) {
      const res = await rest.call('POST', '/api/v1/objects/company/records', {
        key: readWriteKey,
        body: { values: { name: `Page Co ${String(i).padStart(2, '0')}` } },
      });
      expect(res.status).toBe(201);
    }
    const first = await rest.call('GET', '/api/v1/objects/company/records?limit=3', {
      key: readOnlyKey,
    });
    const page1 = recordPageSchema.parse(first.body);
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    const second = await rest.call(
      'GET',
      `/api/v1/objects/company/records?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { key: readOnlyKey },
    );
    const page2 = recordPageSchema.parse(second.body);
    expect(page2.items).toHaveLength(3);
    const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);

    const tooBig = await rest.call('GET', '/api/v1/objects/company/records?limit=500', {
      key: readOnlyKey,
    });
    expect(tooBig.status).toBe(400);
    expect(problemSchema.parse(tooBig.body).code).toBe('VALIDATION');
  });

  it('filters and sorts through POST …/records/query — the RecordQuery DSL', async () => {
    const res = await rest.call('POST', '/api/v1/objects/company/records/query', {
      key: readOnlyKey,
      body: {
        filters: [{ attribute: 'name', op: 'startsWith', value: 'Page Co 0' }],
        sort: [{ attribute: 'name', direction: 'desc' }],
        limit: 2,
      },
    });
    expect(res.status).toBe(200);
    const page = recordPageSchema.parse(res.body);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((r) => r.label)).toEqual(['Page Co 06', 'Page Co 05']);
    expect(page.nextCursor).not.toBeNull();
  });

  it('creates an object type and immediately accepts records for it', async () => {
    const created = await rest.call('POST', '/api/v1/objects', {
      key: readWriteKey,
      body: { apiSlug: 'widget', singular: 'Widget', plural: 'Widgets' },
    });
    expect(created.status).toBe(201);
    const record = await rest.call('POST', '/api/v1/objects/widget/records', {
      key: readWriteKey,
      body: { values: { name: 'Sprocket' } },
    });
    expect(record.status).toBe(201);

    const dup = await rest.call('POST', '/api/v1/objects', {
      key: readWriteKey,
      body: { apiSlug: 'widget', singular: 'Widget', plural: 'Widgets' },
    });
    expect(dup.status).toBe(409);
    expect(problemSchema.parse(dup.body).code).toBe('CONFLICT');
  });
});

describe('idempotency', () => {
  it('replays the stored response instead of creating a second record', async () => {
    const body = { values: { name: 'Idempotent Person' } };
    const key = 'idem-create-0001';
    const first = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body,
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(201);
    const id = recordSchema.parse(first.body).id;

    const second = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body,
      headers: { 'idempotency-key': key },
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(recordSchema.parse(second.body).id).toBe(id);

    const count = await seed.db.runtime.withTenant(
      seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
      (db) =>
        db.record.count({
          where: { objectType: { apiSlug: 'person' }, deletedAt: null },
        }),
    );
    const again = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body,
      headers: { 'idempotency-key': key },
    });
    expect(again.status).toBe(201);
    const countAfter = await seed.db.runtime.withTenant(
      seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
      (db) =>
        db.record.count({
          where: { objectType: { apiSlug: 'person' }, deletedAt: null },
        }),
    );
    expect(countAfter).toBe(count);
  });

  it('409s when one key is reused for a different request', async () => {
    const key = 'idem-conflict-0001';
    const first = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { name: 'First Body' } },
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(201);

    const conflicting = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { name: 'Different Body' } },
      headers: { 'idempotency-key': key },
    });
    expect(conflicting.status).toBe(409);
    const problem = problemSchema.parse(conflicting.body);
    expect(problem.code).toBe('CONFLICT');
    expect(problem.detail).toContain(key);
  });

  it('runs the handler normally when no Idempotency-Key is sent', async () => {
    const body = { values: { name: 'Untracked' } };
    const a = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body,
    });
    const b = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body,
    });
    expect(recordSchema.parse(a.body).id).not.toBe(recordSchema.parse(b.body).id);
  });
});

describe('rate limiting', () => {
  it('emits X-RateLimit-* on every response and 429s past the key’s limit', async () => {
    const tiny = await rest.createKey({ name: 'tiny', scopes: ['READ'], rateLimitPerMinute: 3 });
    const statuses: number[] = [];
    let last: { status: number; body: unknown; headers: Headers } | null = null;
    for (let i = 0; i < 4; i += 1) {
      last = await rest.call('GET', '/api/v1/objects', { key: tiny.plaintext });
      statuses.push(last.status);
      expect(last.headers.get('x-ratelimit-limit')).toBe('3');
      expect(last.headers.get('x-ratelimit-reset')).toMatch(/^\d+$/);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last!.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/);
    const problem = problemSchema.parse(last!.body);
    expect(problem.code).toBe('RATE_LIMITED');
    expect(problem.status).toBe(429);
  });
});

describe('connections', () => {
  it('lists connections without ever projecting a token handle', async () => {
    const res = await rest.call('GET', '/api/v1/connections', { key: readOnlyKey });
    expect(res.status).toBe(200);
    const page = connectionPageSchema.parse(res.body);
    expect(page.items.map((c) => c.id)).toContain(connectionId);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('tokenRef');
    expect(raw).not.toContain('webhookSecretRef');
  });

  it('reports health for one connection', async () => {
    const res = await rest.call('GET', `/api/v1/connections/${connectionId}/health`, {
      key: readOnlyKey,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connectionId,
      platform: 'MOCK',
      failedRuns24h: 0,
      openErrors: 0,
    });
  });

  it('pauses, refuses to sync nothing, resumes, and lists runs', async () => {
    const paused = await rest.call('POST', `/api/v1/connections/${connectionId}/pause`, {
      key: readWriteKey,
      body: { reason: 'Testing' },
    });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ status: 'PAUSED' });

    const resumed = await rest.call('POST', `/api/v1/connections/${connectionId}/resume`, {
      key: readWriteKey,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'CONNECTED' });

    const sync = await rest.call('POST', `/api/v1/connections/${connectionId}/sync`, {
      key: readWriteKey,
      body: { backfill: false },
    });
    expect(sync.status).toBe(202);
    expect(Array.isArray((sync.body as { jobIds: string[] }).jobIds)).toBe(true);

    const runs = await rest.call('GET', `/api/v1/connections/${connectionId}/runs?limit=5`, {
      key: readOnlyKey,
    });
    expect(runs.status).toBe(200);
    syncRunPageSchema.parse(runs.body);
  });

  it('replays a finished run and refuses one that is still going', async () => {
    const actor = seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER');
    const { finished, running } = await seed.db.runtime.withTenant(actor, async (db) => {
      const base = {
        workspaceId: seed.acme.id,
        connectionId,
        resource: 'posts',
        trigger: 'MANUAL' as const,
      };
      return {
        finished: await db.syncRun.create({
          data: { ...base, status: 'SUCCEEDED', finishedAt: new Date() },
        }),
        running: await db.syncRun.create({ data: { ...base, status: 'RUNNING' } }),
      };
    });

    const ok = await rest.call(
      'POST',
      `/api/v1/connections/${connectionId}/runs/${finished.id}/replay`,
      { key: readWriteKey, body: { fromStage: 'normalize' } },
    );
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ runId: finished.id, resource: 'posts' });

    const busy = await rest.call(
      'POST',
      `/api/v1/connections/${connectionId}/runs/${running.id}/replay`,
      { key: readWriteKey, body: {} },
    );
    expect(busy.status).toBe(409);

    const missing = await rest.call(
      'POST',
      `/api/v1/connections/${connectionId}/runs/${mangleId(finished.id)}/replay`,
      { key: readWriteKey, body: {} },
    );
    expect([404, 400]).toContain(missing.status);
  });
});

describe('the thinner surfaces', () => {
  it('lists conversations and their messages', async () => {
    const conversations = await rest.call('GET', '/api/v1/conversations?status=OPEN', {
      key: readOnlyKey,
    });
    expect(conversations.status).toBe(200);
    const page = conversationPageSchema.parse(conversations.body);
    expect(page.items.map((c) => c.id)).toEqual([conversationId]);
    expect(page.items[0]).toMatchObject({ kind: 'DM', platform: 'MOCK', unreadCount: 1 });

    const filteredOut = await rest.call('GET', '/api/v1/conversations?status=CLOSED', {
      key: readOnlyKey,
    });
    expect(conversationPageSchema.parse(filteredOut.body).items).toHaveLength(0);

    const messages = await rest.call(
      'GET',
      `/api/v1/conversations/${conversationId}/messages?limit=10`,
      { key: readOnlyKey },
    );
    expect(messages.status).toBe(200);
    const msgPage = messagePageSchema.parse(messages.body);
    expect(msgPage.items).toHaveLength(1);
    expect(msgPage.items[0]).toMatchObject({ direction: 'INBOUND', body: 'hello?' });

    expect(
      (
        await rest.call('GET', `/api/v1/conversations/${mangleId(conversationId)}/messages`, {
          key: readOnlyKey,
        })
      ).status,
    ).toBe(404);
  });

  it('sends a reply through the same preflight → OutboundAction flow as the composer', async () => {
    const res = await rest.call('POST', `/api/v1/conversations/${conversationId}/messages`, {
      key: readWriteKey,
      body: { text: 'Thanks for getting in touch!' },
      headers: { 'idempotency-key': 'reply-once-0001' },
    });
    expect(res.status).toBe(202);
    const outcome = replyOutcomeSchema.parse(res.body);
    expect(['queued', 'blocked']).toContain(outcome.status);
    expect(outcome.outboundActionId).toMatch(/^[0-9a-f-]{36}$/);

    // The action is attributed to the connection's owner — an API key has no user of its own.
    const action = await seed.db.runtime.withTenant(
      seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
      (db) => db.outboundAction.findFirstOrThrow({ where: { id: outcome.outboundActionId } }),
    );
    expect(action.requestedByUserId).toBe(seed.users.alice.id);
    expect(action.conversationId).toBe(conversationId);

    // A READ-only key cannot send, and an unknown conversation is a 404, not a 500.
    expect(
      (
        await rest.call('POST', `/api/v1/conversations/${conversationId}/messages`, {
          key: readOnlyKey,
          body: { text: 'nope' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rest.call('POST', `/api/v1/conversations/${mangleId(conversationId)}/messages`, {
          key: readWriteKey,
          body: { text: 'nope' },
        })
      ).status,
    ).toBe(404);
  });

  it('searches across objects', async () => {
    const search = await rest.call('GET', '/api/v1/search?q=Page%20Co', { key: readOnlyKey });
    expect(search.status).toBe(200);
    const groups = (search.body as { groups: { objectType: { apiSlug: string } }[] }).groups;
    expect(groups.some((g) => g.objectType.apiSlug === 'company')).toBe(true);
  });

  it('returns a person’s timeline and 404s a record that is not a person', async () => {
    const person = await rest.call('POST', '/api/v1/objects/person/records', {
      key: readWriteKey,
      body: { values: { name: 'Timeline Person' } },
    });
    const id = recordSchema.parse(person.body).id;
    const timeline = await rest.call('GET', `/api/v1/people/${id}/timeline?limit=10`, {
      key: readOnlyKey,
    });
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({ nextCursor: null });

    const company = await rest.call('POST', '/api/v1/objects/company/records', {
      key: readWriteKey,
      body: { values: { name: 'Not A Person' } },
    });
    const companyId = recordSchema.parse(company.body).id;
    expect(
      (await rest.call('GET', `/api/v1/people/${companyId}/timeline`, { key: readOnlyKey })).status,
    ).toBe(404);
  });

  it('adds a record to a list and pages its entries', async () => {
    const owner = seed.caller(seed.users.alice, 'acme');
    const list = await owner.list.create({
      objectType: 'company',
      name: 'REST pipeline',
      kind: 'COLLECTION',
    });
    const created = await rest.call('POST', '/api/v1/objects/company/records', {
      key: readWriteKey,
      body: { values: { name: 'Listed Co' } },
    });
    const recordId = recordSchema.parse(created.body).id;

    const added = await rest.call('POST', `/api/v1/lists/${list.id}/entries`, {
      key: readWriteKey,
      body: { recordId },
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ recordId, label: 'Listed Co' });

    const entries = await rest.call('GET', `/api/v1/lists/${list.id}/entries?limit=10`, {
      key: readOnlyKey,
    });
    expect(entries.status).toBe(200);
    expect((entries.body as { items: unknown[] }).items).toHaveLength(1);
  });
});
