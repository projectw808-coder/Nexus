import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import {
  createTestAuthCtx,
  createTestConnCtx,
  createTestNormalizeCtx,
} from '@nexus/connector-sdk/testing';
import { createKeitaroConnector, type KeitaroConfig } from './connector.ts';
import { keitaroManifest, KINDS } from './manifest.ts';
import { createKeitaroDouble } from './testing/keitaro-double.ts';
import keitaroConversion from './fixtures/keitaro_conversion.json' with { type: 'json' };
import keitaroConversionRejected from './fixtures/keitaro_conversion.rejected.json' with { type: 'json' };
import keitaroConversionDrift from './fixtures/keitaro_conversion.drift.json' with { type: 'json' };
import keitaroCampaign from './fixtures/keitaro_campaign.json' with { type: 'json' };

const config = {};
const connector = createKeitaroConnector(config);
const baseUrl = 'https://tracker.customer.example';

function ctxFor(
  double: ReturnType<typeof createKeitaroDouble>,
  extra: Partial<Parameters<typeof createTestConnCtx<KeitaroConfig>>[0]> = {},
) {
  return createTestConnCtx<KeitaroConfig>({
    manifest: keitaroManifest,
    fetch: double.fetch,
    config,
    accountExternalId: 'tracker.customer.example',
    token: { accessToken: double.apiKey, scopes: [], tokenType: 'ApiKey', raw: {} },
    settings: { baseUrl },
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

const shared = createKeitaroDouble({ totalConversions: 25 });

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(shared),
    resource: 'keitaro.conversions',
    scenarios: {
      rateLimited: () => ctxFor(createKeitaroDouble({ forceStatus: 429 })),
      expiredToken: () => ctxFor(createKeitaroDouble({ forceStatus: 401 })),
    },
    // No `webhook` here: `shared_secret` (the secret rides in the query string, per §8.6 — a
    // Keitaro postback URL is a plain macro-templated URL with no signing capability) proves
    // the sender knows the secret, not body integrity, so the contract suite's universal
    // tamper-rejection check does not apply to it. Verified separately below instead.
    fixtures: [
      { kind: KINDS.conversion, raw: keitaroConversion },
      { kind: KINDS.conversion, raw: keitaroConversionRejected },
      { kind: KINDS.campaign, raw: keitaroCampaign },
    ],
    normalizeCtx: createTestNormalizeCtx(keitaroManifest, {
      accountExternalId: 'tracker.customer.example',
    }),
  },
);

describe('Keitaro connector', () => {
  it('has no OAuth redirect flow — api_key connectors refuse it', async () => {
    const auth = createTestAuthCtx({ config });
    expect(() => connector.buildAuthUrl(auth, { scopes: [], state: 's' })).toThrow(NexusError);
    await expect(connector.exchangeCode(auth, 'code')).rejects.toBeInstanceOf(NexusError);
  });

  it('refuses to refresh — an API key does not expire and does not rotate', async () => {
    const auth = createTestAuthCtx({ config });
    await expect(
      connector.refresh(auth, { accessToken: 'k', scopes: [], tokenType: 'ApiKey', raw: {} }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('revoke is a best-effort no-op — Keitaro has no revoke endpoint', async () => {
    const auth = createTestAuthCtx({ config });
    await expect(
      connector.revoke(auth, { accessToken: 'k', scopes: [], tokenType: 'ApiKey', raw: {} }),
    ).resolves.toBeUndefined();
  });

  it('discovers the tracker itself as the single account', async () => {
    const ctx = ctxFor(shared);
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.platform).toBe('KEITARO');
  });

  it('is entirely read-only: preflight always blocks, execute always throws', async () => {
    const ctx = ctxFor(shared);
    const preflight = await connector.preflight(ctx, {
      id: 'oa_1',
      kind: 'reply_dm',
      payload: {},
      idempotencyKey: 'k',
      requestNonce: 'n',
      requestedByUserId: 'u1',
    });
    expect(preflight).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    await expect(
      connector.execute(ctx, {
        id: 'oa_1',
        kind: 'reply_dm',
        payload: {},
        idempotencyKey: 'k',
        requestNonce: 'n',
        requestedByUserId: 'u1',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('pages conversions with a high-water mark and resumes with a cursor', async () => {
    const ctx = ctxFor(shared);
    const first = await connector.fetchPage(ctx, {
      id: 'keitaro.conversions',
      since: null,
      highWaterMark: null,
    });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(shared.conversions.length);
    expect(first.nextCursor).toBeTruthy();
    expect(first.highWaterMark).toBeInstanceOf(Date);
  });

  it('normalizes a conversion into a canonical conversion with attribution and sub_ids', () => {
    const nctx = createTestNormalizeCtx(keitaroManifest);
    const [entity] = connector.normalize(KINDS.conversion, keitaroConversion, nctx);
    expect(entity).toMatchObject({
      kind: 'conversion',
      subid: '5f3a1c9e8b2d',
      tid: 'tx_1',
      status: 'sale',
      payout: 42.5,
      currency: 'USD',
      campaign: { externalId: '11', name: 'Spring Promo' },
      geo: { country: 'US', region: 'CA' },
    });
    expect((entity as { subIds: Record<string, string> }).subIds).toMatchObject({
      sub_id_1: 'lead@example.com',
      sub_id_2: 'crm-88213',
    });
  });

  it('refuses a drifted shape so core can quarantine it', () => {
    const nctx = createTestNormalizeCtx(keitaroManifest);
    expect(() => connector.normalize(KINDS.conversion, keitaroConversionDrift, nctx)).toThrow();
    expect(() => connector.normalize('keitaro_unknown', {}, nctx)).toThrow(NexusError);
  });

  it('verifies the webhook via the shared secret in the query string, not the body', () => {
    const req = {
      method: 'POST',
      path: '/api/webhooks/keitaro/conn_abc123',
      headers: {},
      rawBody: JSON.stringify(keitaroConversion),
      query: { key: 'wh-secret' },
    };
    expect(connector.verifyWebhook(req, 'wh-secret')).toBe(true);
    expect(connector.verifyWebhook(req, 'wrong-secret')).toBe(false);
    expect(connector.verifyWebhook({ ...req, query: {} }, 'wh-secret')).toBe(false);
    const [env] = connector.parseWebhook(req);
    expect(env).toMatchObject({
      kind: KINDS.conversion,
      externalId: String(keitaroConversion.conversion_id),
      connectionHint: { platform: 'KEITARO', connectionId: 'conn_abc123' },
    });
  });

  it('reports health without throwing when the API key is rejected', async () => {
    const down = ctxFor(createKeitaroDouble({ forceStatus: 401 }));
    const report = await connector.health(down);
    expect(report.status).toBe('reconnect_required');
    expect(report.checks.find((c) => c.id === 'token')?.ok).toBe(false);
  });

  it('reports health as down when the tracker is unreachable', async () => {
    const unreachable = ctxFor(shared, {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const report = await connector.health(unreachable);
    expect(report.status).toBe('down');
  });
});
