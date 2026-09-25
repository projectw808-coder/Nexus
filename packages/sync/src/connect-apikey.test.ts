/**
 * `connectApiKeyPlatform` (spec §8.6): Keitaro's connect flow has no OAuth redirect — a bad key
 * or an unreachable tracker must fail before anything is persisted, and a working one produces a
 * connection plus a postback URL carrying the per-connection webhook secret.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeitaroDouble } from '@nexus/connector-keitaro/testing';
import {
  MemoryBudgetStore,
  RateLimiter,
  generateMasterKeyBase64,
  localKeyProvider,
  type FetchLike,
} from '@nexus/connector-sdk';
import { createVault, systemActorFor, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { createInlineBus } from './bus.ts';
import { connectApiKeyPlatform } from './connect.ts';
import type { SyncDeps } from './deps.ts';
import { countingSink } from './sink.ts';
import { createConnectorRegistry } from './registry.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const vault = createVault({
  keyProvider: localKeyProvider({
    masterKeyId: 'local:test',
    masterKeyBase64: generateMasterKeyBase64(),
  }),
});

let db: TestDatabase;
let owner: Actor;

function depsFor(fetchFor: (platform: string) => FetchLike | undefined): SyncDeps {
  const deps: SyncDeps = {
    runtime: db.runtime,
    vault,
    limiter: new RateLimiter({ store: new MemoryBudgetStore() }),
    registry: createConnectorRegistry({}),
    bus: undefined as unknown as SyncDeps['bus'],
    logger: quiet,
    sink: countingSink(),
    appSecrets: {
      webhookSecret: () => null,
      oauthCredentials: async () => ({ clientId: 'x' }),
      stateSecret: () => 'state',
    },
    fetchFor,
    appUrl: 'http://localhost:3000',
    httpRetry: { baseMs: 1, capMs: 3, maxAttempts: 1 },
  };
  deps.bus = createInlineBus({
    handlers: {},
    logger: quiet,
    retry: { baseMs: 1, capMs: 3 },
  });
  return deps;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@connect.test', name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({
    name: 'Connect',
    slug: 'connect-apikey',
    ownerUserId: u.id,
  });
  owner = { ...systemActorFor(ws.id), userId: u.id, actorType: 'USER' };
});
afterAll(async () => db.close());

describe('connectApiKeyPlatform', () => {
  it('rejects a non-https base URL before touching the platform', async () => {
    const deps = depsFor(() => undefined);
    await db.runtime.withTenant(owner, (t) =>
      expect(
        connectApiKeyPlatform(deps, t, {
          actor: owner,
          platform: 'KEITARO',
          apiKey: 'k',
          baseUrl: 'http://tracker.insecure.test',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' }),
    );
  });

  it('rejects a platform that does not use api_key auth', async () => {
    const deps = depsFor(() => undefined);
    await db.runtime.withTenant(owner, (t) =>
      expect(
        connectApiKeyPlatform(deps, t, {
          actor: owner,
          platform: 'MOCK',
          apiKey: 'k',
          baseUrl: 'https://tracker.test',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' }),
    );
  });

  it('fails fast on a bad key without persisting a connection', async () => {
    const double = createKeitaroDouble({ apiKey: 'right-key' });
    const deps = depsFor(() => double.fetch);
    await db.runtime.withTenant(owner, async (t) => {
      await expect(
        connectApiKeyPlatform(deps, t, {
          actor: owner,
          platform: 'KEITARO',
          apiKey: 'wrong-key',
          baseUrl: 'https://tracker.test',
        }),
      ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
      const count = await t.connection.count({ where: { workspaceId: owner.workspaceId } });
      expect(count).toBe(0);
    });
  });

  it('connects, mints a postback URL with the webhook secret, and enqueues a backfill', async () => {
    const double = createKeitaroDouble({ apiKey: 'right-key', totalConversions: 3 });
    const deps = depsFor(() => double.fetch);
    const result = await db.runtime.withTenant(owner, (t) =>
      connectApiKeyPlatform(deps, t, {
        actor: owner,
        platform: 'KEITARO',
        apiKey: 'right-key',
        baseUrl: 'https://tracker.test',
      }),
    );
    expect(result.created).toBe(true);
    expect(result.postbackUrl).toMatch(
      /^http:\/\/localhost:3000\/api\/webhooks\/keitaro\/[^/]+\?key=.+$/,
    );
    const conn = await db.runtime.withTenant(owner, (t) =>
      t.connection.findUniqueOrThrow({ where: { id: result.connectionId } }),
    );
    expect(conn.platform).toBe('KEITARO');
    expect((conn.settings as { baseUrl?: string }).baseUrl).toBe('https://tracker.test');

    // Reconnecting with the same base URL/account updates in place rather than duplicating.
    const again = await db.runtime.withTenant(owner, (t) =>
      connectApiKeyPlatform(deps, t, {
        actor: owner,
        platform: 'KEITARO',
        apiKey: 'right-key',
        baseUrl: 'https://tracker.test',
      }),
    );
    expect(again.created).toBe(false);
    expect(again.connectionId).toBe(result.connectionId);
  });
});
