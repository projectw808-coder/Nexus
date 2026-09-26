/**
 * Phase 9 acceptance: a token expiring within the 7-day RECONNECT_WARNING_MS window shows up as
 * `reconnect_soon`, e-mails the workspace owner through `mailNotifier`, and pauses only its own
 * connection — siblings in the same workspace, and connections with no owner on file, are
 * unaffected (§5.4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryBudgetStore,
  RateLimiter,
  generateMasterKeyBase64,
  localKeyProvider,
  type Logger,
} from '@nexus/connector-sdk';
import { createVault, systemActorFor, upsertConnection, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import { MemoryMailProvider } from '@nexus/mail';
import { createInlineBus } from './bus.ts';
import type { SyncDeps } from './deps.ts';
import { createConnectorRegistry } from './registry.ts';
import { countingSink } from './sink.ts';
import { mailNotifier, sweepTokens } from './token-refresh.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const vault = createVault({
  keyProvider: localKeyProvider({
    masterKeyId: 'local:test',
    masterKeyBase64: generateMasterKeyBase64(),
  }),
});

let db: TestDatabase;
let wsSeq = 0;

function makeDeps(now: Date): SyncDeps {
  return {
    runtime: db.runtime,
    vault,
    limiter: new RateLimiter({
      store: new MemoryBudgetStore(),
      random: () => 0.5,
      breaker: { baseOpenMs: 5, maxOpenMs: 20 },
    }),
    registry: createConnectorRegistry(),
    bus: createInlineBus({ handlers: {} }),
    logger: quiet,
    sink: countingSink(),
    appSecrets: {
      webhookSecret: () => null,
      oauthCredentials: async () => ({ clientId: 'client', clientSecret: 'secret' }),
      stateSecret: () => 'state-secret-for-tests',
    },
    appUrl: 'https://app.nexus.test',
    now: () => now,
  };
}

async function seedWorkspace(ownerEmail: string) {
  wsSeq += 1;
  const owner = await db.prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({
    name: `Acme ${wsSeq}`,
    slug: `acme-tr-${wsSeq}`,
    ownerUserId: owner.id,
  });
  return { owner, actor: systemActorFor(ws.id) };
}

async function seedConnection(
  actor: Actor,
  opts: { label: string; ownerUserId: string | null; expiresAt: Date },
) {
  return db.runtime.withTenant(actor, async (tx) => {
    const { ref } = await vault.putTokenSet(tx, actor.workspaceId, {
      accessToken: `at_${opts.label}`,
      // No refresh token: the sweep must raise `reconnect_soon` rather than refresh it.
      refreshToken: undefined,
      expiresAt: opts.expiresAt,
      scopes: [],
      tokenType: 'Bearer',
      raw: {},
    });
    const { id } = await upsertConnection(tx, {
      workspaceId: actor.workspaceId,
      platform: 'MOCK',
      label: opts.label,
      accountExternalId: opts.label,
      accountName: opts.label,
      scopesGranted: [],
      scopesRequired: [],
      capabilities: [],
      apiVersion: '2026-09',
      tokenRef: ref,
      tokenExpiresAt: opts.expiresAt,
      ownerUserId: opts.ownerUserId,
    });
    return id;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.close());

describe('sweepTokens + mailNotifier', () => {
  it('e-mails the workspace owner and pauses only the connection nearing expiry', async () => {
    const { owner, actor } = await seedWorkspace(`owner-${wsSeq + 1}@token-refresh.test`);
    const now = new Date();
    const soonId = await seedConnection(actor, {
      label: 'Acme — Instagram (@acmehq)',
      ownerUserId: owner.id,
      expiresAt: new Date(now.getTime() + 3 * 86_400_000), // inside the 7-day window
    });
    const fineId = await seedConnection(actor, {
      label: 'Acme — X (@acmehq)',
      ownerUserId: owner.id,
      expiresAt: new Date(now.getTime() + 20 * 86_400_000), // outside the 7-day window
    });

    const mail = new MemoryMailProvider();
    const notifier = mailNotifier({ mail, appUrl: 'https://app.nexus.test/', log: quiet });
    const result = await sweepTokens(makeDeps(now), { notifier });
    expect(result.reconnectRequired).toBeGreaterThanOrEqual(1);

    const soon = await db.runtime.withTenant(actor, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: soonId } }),
    );
    const fine = await db.runtime.withTenant(actor, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: fineId } }),
    );
    expect(soon.status).toBe('RECONNECT_REQUIRED');
    expect(soon.pausedReason).toMatch(/7 days/);
    // Pausing one connection's token never touches its sibling.
    expect(fine.status).toBe('CONNECTED');

    const sent = mail.last('connection.reconnect_required');
    expect(sent).toBeDefined();
    expect(sent!.to).toBe(owner.email);
    expect(sent!.text).toContain('Acme — Instagram (@acmehq)');
    expect(sent!.html).toContain('Acme — Instagram (@acmehq)');
    expect(sent!.text).not.toContain('Acme — X (@acmehq)');
  });

  it('pauses a connection with no owner on file but does not throw or send mail for it', async () => {
    const { actor } = await seedWorkspace(`workspace-owner-${wsSeq + 1}@token-refresh.test`);
    const now = new Date();
    const orphanId = await seedConnection(actor, {
      label: 'Acme — TikTok (@acmehq)',
      ownerUserId: null,
      expiresAt: new Date(now.getTime() + 2 * 86_400_000),
    });

    const mail = new MemoryMailProvider();
    const notifier = mailNotifier({ mail, appUrl: 'https://app.nexus.test/', log: quiet });
    await expect(sweepTokens(makeDeps(now), { notifier })).resolves.toMatchObject({
      failed: 0,
    });

    const orphan = await db.runtime.withTenant(actor, (tx) =>
      tx.connection.findUniqueOrThrow({ where: { id: orphanId } }),
    );
    expect(orphan.status).toBe('RECONNECT_REQUIRED');
    expect(mail.last('connection.reconnect_required')).toBeUndefined();
  });
});
