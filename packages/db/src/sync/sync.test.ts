import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKeyBase64, localKeyProvider } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import type { Actor } from '../scoped.ts';
import { createVault } from '../vault.ts';
import {
  systemActorFor,
  upsertConnection,
  getConnection,
  setConnectionStatus,
  findConnectionForWebhook,
  listSchedulableConnections,
} from './connections.ts';
import { loadCursor, saveCursor, clearCursor } from './cursors.ts';
import { recordDeadLetter, listDeadLetters, markReplayed } from './dead-letters.ts';
import { recordIntegrationError } from './errors.ts';
import {
  contentHashOf,
  pendingNormalization,
  persistRawItems,
  stableStringify,
} from './raw-store.ts';
import { finishRun, progressRun, startRun } from './runs.ts';

let db: TestDatabase;
let actor: Actor;
let other: Actor;
let userId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@sync.test', name: 'Owner' } });
  userId = u.id;
  const ws = await db.tenancy.createWorkspace({ name: 'Sync', slug: 'sync', ownerUserId: u.id });
  const ws2 = await db.tenancy.createWorkspace({ name: 'Other', slug: 'other', ownerUserId: u.id });
  actor = systemActorFor(ws.id);
  other = systemActorFor(ws2.id);
});
afterAll(async () => db.close());

describe('vault', () => {
  const vault = createVault({
    keyProvider: localKeyProvider({
      masterKeyId: 'local:test',
      masterKeyBase64: generateMasterKeyBase64(),
    }),
  });

  it('puts, gets, rotates and revokes without ever storing plaintext', async () => {
    const { ref } = await db.runtime.withTenant(actor, (tx) =>
      vault.put(tx, { workspaceId: actor.workspaceId, kind: 'API_KEY', secret: 'sk_live_123' }),
    );
    const rows = await db.sqlAsSuperuser(
      'SELECT ciphertext, iv, tag FROM "VaultEntry" WHERE id = $1',
      [ref],
    );
    expect(JSON.stringify(rows)).not.toContain('sk_live');
    const keys = await db.sqlAsSuperuser(
      'SELECT "wrappedKey" FROM "WorkspaceKey" WHERE "workspaceId" = $1',
      [actor.workspaceId],
    );
    expect(keys).toHaveLength(1);
    const read = await db.runtime.withTenant(actor, (tx) => vault.get(tx, ref));
    expect(read.secret).toBe('sk_live_123');
    expect(read.version).toBe(1);
    await db.runtime.withTenant(actor, (tx) => vault.rotate(tx, ref, 'sk_live_456'));
    const rotated = await db.runtime.withTenant(actor, (tx) => vault.get(tx, ref));
    expect(rotated.secret).toBe('sk_live_456');
    expect(rotated.version).toBe(2);
    await db.runtime.withTenant(actor, (tx) => vault.revoke(tx, ref));
    await expect(db.runtime.withTenant(actor, (tx) => vault.get(tx, ref))).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    const wiped = await db.sqlAsSuperuser('SELECT ciphertext FROM "VaultEntry" WHERE id = $1', [
      ref,
    ]);
    expect((wiped[0] as { ciphertext: string }).ciphertext).toBe('');
  });

  it('round-trips a TokenSet and keeps it invisible to other tenants', async () => {
    const token = {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      scopes: ['read:posts'],
      tokenType: 'Bearer',
      raw: { access_token: 'at' },
    };
    const { ref } = await db.runtime.withTenant(actor, (tx) =>
      vault.putTokenSet(tx, actor.workspaceId, token),
    );
    const got = await db.runtime.withTenant(actor, (tx) => vault.getTokenSet(tx, ref));
    expect(got.token.accessToken).toBe('at');
    expect(got.token.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    await expect(
      db.runtime.withTenant(other, (tx) => vault.getTokenSet(tx, ref)),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });
});

describe('raw store', () => {
  let connectionId: string;
  beforeAll(async () => {
    const r = await db.runtime.withTenant(actor, (tx) =>
      upsertConnection(tx, {
        workspaceId: actor.workspaceId,
        platform: 'MOCK',
        label: 'Mock — acct_1',
        accountExternalId: 'acct_1',
        accountName: 'Account One',
        scopesGranted: ['read:posts'],
        scopesRequired: ['read:posts'],
        capabilities: ['read:posts'],
        apiVersion: '2026-09',
        tokenRef: 'ref',
        ownerUserId: userId,
      }),
    );
    connectionId = r.id;
    expect(r.created).toBe(true);
  });

  it('hashes payloads independent of key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(contentHashOf({ b: 1, a: 2 })).toBe(contentHashOf({ a: 2, b: 1 }));
  });

  it('creates, skips unchanged, updates changed and de-duplicates within a batch', async () => {
    const base = {
      workspaceId: actor.workspaceId,
      connectionId,
      platform: 'MOCK' as const,
      apiVersion: '2026-09',
    };
    const first = await db.runtime.withTenant(actor, (tx) =>
      persistRawItems(tx, {
        ...base,
        items: [
          { kind: 'mock_post', externalId: 'p1', raw: { body: 'hi' } },
          { kind: 'mock_post', externalId: 'p2', raw: { body: 'yo' } },
          { kind: 'mock_post', externalId: 'p1', raw: { body: 'hi' } },
        ],
      }),
    );
    expect(first.created).toHaveLength(2);
    expect(first.skipped).toBe(0);
    const second = await db.runtime.withTenant(actor, (tx) =>
      persistRawItems(tx, {
        ...base,
        items: [
          { kind: 'mock_post', externalId: 'p1', raw: { body: 'hi' } },
          { kind: 'mock_post', externalId: 'p2', raw: { body: 'edited' } },
          { kind: 'mock_comment', externalId: 'p1', raw: { text: 'same id, other kind' } },
        ],
      }),
    );
    expect(second.created).toHaveLength(1);
    expect(second.updated).toHaveLength(1);
    expect(second.skipped).toBe(1);
    const rows = await db.runtime.withTenant(actor, (tx) =>
      tx.externalObject.findMany({
        where: { connectionId },
        orderBy: [{ kind: 'asc' }, { externalId: 'asc' }],
      }),
    );
    expect(rows.map((r) => `${r.kind}:${r.externalId}`)).toEqual([
      'mock_comment:p1',
      'mock_post:p1',
      'mock_post:p2',
    ]);
    expect(rows.find((r) => r.externalId === 'p2' && r.kind === 'mock_post')?.raw).toEqual({
      body: 'edited',
    });
    const pending = await db.runtime.withTenant(actor, (tx) =>
      pendingNormalization(tx, connectionId),
    );
    expect(pending).toHaveLength(3);
  });

  it('is invisible across the tenant boundary', async () => {
    const rows = await db.runtime.withTenant(other, (tx) =>
      tx.externalObject.findMany({ where: { connectionId } }),
    );
    expect(rows).toEqual([]);
  });

  it('keeps cursors, runs, errors and dead letters per connection', async () => {
    await db.runtime.withTenant(actor, async (tx) => {
      expect(await loadCursor(tx, connectionId, 'mock.posts')).toBeNull();
      await saveCursor(tx, {
        workspaceId: actor.workspaceId,
        connectionId,
        resource: 'mock.posts',
        cursor: 'c1',
        highWaterMark: new Date('2026-09-01T00:00:00Z'),
      });
      await saveCursor(tx, {
        workspaceId: actor.workspaceId,
        connectionId,
        resource: 'mock.posts',
        cursor: 'c2',
        highWaterMark: new Date('2026-08-01T00:00:00Z'),
      });
      const c = await loadCursor(tx, connectionId, 'mock.posts');
      expect(c?.cursor).toBe('c2');
      expect(c?.highWaterMark?.toISOString()).toBe('2026-09-01T00:00:00.000Z'); // never moves backwards
      await clearCursor(tx, connectionId, 'mock.posts');
      expect((await loadCursor(tx, connectionId, 'mock.posts'))?.cursor).toBeNull();

      const run = await startRun(tx, {
        workspaceId: actor.workspaceId,
        connectionId,
        resource: 'mock.posts',
        trigger: 'BACKFILL',
      });
      await progressRun(tx, run.id, { fetched: 10, created: 8, skipped: 2, budgetSpent: 1 });
      await progressRun(tx, run.id, { fetched: 5, updated: 1 });
      const err = new NexusError('RATE_LIMITED', {
        context: { platformName: 'Mock', usagePercent: 95 },
        details: { status: 429 },
      });
      await finishRun(tx, run.id, { status: 'FAILED', error: err });
      const row = await tx.syncRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row).toMatchObject({
        itemsFetched: 15,
        itemsCreated: 8,
        itemsUpdated: 1,
        itemsSkipped: 2,
        budgetSpent: 1,
        status: 'FAILED',
        errorCode: 'RATE_LIMITED',
      });
      expect(row.remediation).toBeTruthy();

      const ie = await recordIntegrationError(tx, {
        workspaceId: actor.workspaceId,
        connectionId,
        syncRunId: run.id,
        platform: 'MOCK',
        error: err,
      });
      const ieRow = await tx.integrationError.findUniqueOrThrow({ where: { id: ie.id } });
      expect(ieRow.errorClass).toBe('RATE_LIMITED');
      expect(ieRow.httpStatus).toBe(429);

      const dl = await recordDeadLetter(tx, {
        workspaceId: actor.workspaceId,
        connectionId,
        queue: 'sync.backfill',
        jobName: 'sync',
        payload: { resource: 'mock.posts' },
        error: err,
        attempts: 6,
      });
      expect(await listDeadLetters(tx, { connectionId })).toHaveLength(1);
      await markReplayed(tx, dl.id, 'job-1');
      expect(await listDeadLetters(tx, { connectionId })).toHaveLength(0);
      expect(await listDeadLetters(tx, { connectionId, includeReplayed: true })).toHaveLength(1);
    });
  });

  it('transitions status and answers the cross-tenant lookups the receiver needs', async () => {
    await db.runtime.withTenant(actor, (tx) =>
      setConnectionStatus(tx, connectionId, 'RECONNECT_REQUIRED', {
        pausedReason: 'token expired',
      }),
    );
    const c = await db.runtime.withTenant(actor, (tx) => getConnection(tx, connectionId));
    expect(c?.status).toBe('RECONNECT_REQUIRED');
    expect(c?.settings.backfillDays).toBe(90);
    expect(
      await findConnectionForWebhook(db.runtime, { platform: 'MOCK', accountExternalId: 'acct_1' }),
    ).toMatchObject({ id: connectionId });
    expect(
      await findConnectionForWebhook(db.runtime, { platform: 'MOCK', connectionId }),
    ).toMatchObject({ workspaceId: actor.workspaceId });
    expect(
      await findConnectionForWebhook(db.runtime, { platform: 'X', accountExternalId: 'acct_1' }),
    ).toBeNull();
    expect((await listSchedulableConnections(db.runtime)).map((x) => x.id)).not.toContain(
      connectionId,
    );
    await db.runtime.withTenant(actor, (tx) =>
      setConnectionStatus(tx, connectionId, 'CONNECTED', { pausedReason: null }),
    );
    expect((await listSchedulableConnections(db.runtime)).map((x) => x.id)).toContain(connectionId);
  });
});
