import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import { simulateQuota } from '@nexus/connector-sdk';
import { createTestConnCtx, createTestNormalizeCtx } from '@nexus/connector-sdk/testing';
import { createXConnector, type XConfig } from './connector.ts';
import { xManifest, KINDS, RATE_CARD, DEFAULT_PAGE_SIZE } from './manifest.ts';
import { createXDouble } from './testing/x-double.ts';
import xMention from './fixtures/x_mention.json' with { type: 'json' };
import xMentionDeleted from './fixtures/x_mention.deleted.json' with { type: 'json' };
import xMentionDrift from './fixtures/x_mention.drift.json' with { type: 'json' };
import xDmEvent from './fixtures/x_dm_event.json' with { type: 'json' };

const config: XConfig = { baseUrl: 'https://x.example.test' };
const connector = createXConnector(config);

function ctxFor(
  double: ReturnType<typeof createXDouble>,
  extra: Partial<Parameters<typeof createTestConnCtx<XConfig>>[0]> = {},
) {
  return createTestConnCtx<XConfig>({
    manifest: xManifest,
    fetch: double.fetch,
    config,
    accountExternalId: double.accountId,
    token: {
      accessToken: double.accessToken,
      scopes: xManifest.scopes.map((s) => s.id),
      tokenType: 'Bearer',
      raw: {},
    },
    // metered_credits requires a spend cap before any reserve() succeeds; generous headroom so
    // the contract suite and the other functional tests below never trip it by accident — the
    // dedicated hard-stop test below configures its own tiny cap.
    settings: { spendCap: { monthlyCapUnits: 10_000, alertThresholdFraction: 0.9 } },
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

// Shared across the whole contract suite (and the plain functional tests below) so the
// cursor-resume check — which builds a brand-new `ConnCtx` and expects to see the SAME
// server-side pagination state — has something real to resume from.
const shared = createXDouble({ totalMentions: 250, totalDms: 30 });

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(shared),
    resource: 'x.mentions',
    scenarios: {
      rateLimited: () => ctxFor(createXDouble({ forceStatus: 429 })),
      expiredToken: () => ctxFor(createXDouble({ forceStatus: 401 })),
    },
    // No `webhook` field: `webhooks.supported` is false for this connector (classic Account
    // Activity webhooks are deprecated; the filtered-stream alternative is out of scope today —
    // see docs/connectors/x.md "Not supported"), so the universal webhook contract does not apply.
    fixtures: [
      { kind: KINDS.mention, raw: xMention },
      { kind: KINDS.dm, raw: xDmEvent },
    ],
    normalizeCtx: createTestNormalizeCtx(xManifest, { accountExternalId: shared.accountId }),
  },
);

describe('X connector', () => {
  it('has no webhook support: verifyWebhook and parseWebhook are always inert', () => {
    const req = {
      method: 'POST',
      path: '/api/webhooks/x/conn_1',
      headers: {},
      rawBody: '{}',
      query: {},
    };
    expect(connector.verifyWebhook(req, 'secret')).toBe(false);
    expect(connector.parseWebhook(req)).toEqual([]);
  });

  it('discovers the single authenticated X user as the account (no Page-style fan-out)', async () => {
    const ctx = ctxFor(shared);
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      platform: 'X',
      externalId: shared.accountId,
      handle: 'test_account',
    });
  });

  // ── billing is per resource READ, not per API call ──────────────────────

  it('dedup ledger: re-polling the same resource+account the same UTC day charges once', async () => {
    const fixedNow = Date.UTC(2026, 8, 24, 10, 0, 0);
    const double = createXDouble({ totalMentions: 10, totalDms: 0 });
    const ctx = ctxFor(double, { now: () => fixedNow });

    const first = await connector.fetchPage(ctx, {
      id: 'x.mentions',
      since: null,
      highWaterMark: null,
    });
    expect(first.items).toHaveLength(10);
    const afterFirst = await ctx.budget.snapshot();
    const usedAfterFirst = afterFirst.windows.reduce((s, w) => s + w.used, 0);
    expect(usedAfterFirst).toBeCloseTo(10 * RATE_CARD['x.mentions'], 6);

    // Same account, same resource, same UTC day, a different (fresh) cursor round-trip — this is
    // a re-poll, not a resume — must be free per the 24h dedup ledger.
    const second = await connector.fetchPage(ctx, {
      id: 'x.mentions',
      since: null,
      highWaterMark: null,
    });
    expect(second.items).toHaveLength(10);
    expect(second.budgetSpent).toBe(0);
    const afterSecond = await ctx.budget.snapshot();
    const usedAfterSecond = afterSecond.windows.reduce((s, w) => s + w.used, 0);
    expect(usedAfterSecond).toBe(usedAfterFirst);
  });

  it('spend-cap hard stop: QUOTA_EXHAUSTED once the monthly cap is spent', async () => {
    const double = createXDouble({ totalMentions: 5, totalDms: 5 });
    const ctx = ctxFor(double, {
      settings: {
        spendCap: {
          monthlyCapUnits: DEFAULT_PAGE_SIZE * RATE_CARD['x.mentions'],
          alertThresholdFraction: 1,
        },
      },
    });
    // Consumes almost the entire cap (5 items at $0.005 = $0.025 of a $0.5 cap) but the mentions
    // resourceKey is now itself deduped for the rest of the day — switch resources to prove the
    // cap, not the ledger, is what stops the next read.
    const first = await connector.fetchPage(ctx, {
      id: 'x.mentions',
      since: null,
      highWaterMark: null,
    });
    expect(first.items).toHaveLength(5);

    let caught: unknown;
    try {
      await connector.fetchPage(ctx, { id: 'x.dms', since: null, highWaterMark: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).code).toBe('QUOTA_EXHAUSTED');
  });

  it('quota simulator: projected daily credit spend matches hand-computed arithmetic', () => {
    const result = simulateQuota({
      manifest: xManifest,
      resources: [{ id: 'x.mentions', intervalSeconds: 300 }],
      volume: { 'x.mentions': { itemsPerDay: 500, pageSize: 100 } },
      monthlyCapUnits: 5_000,
    });
    // Hand computation (spec §8.2 rate card): polling every 5 minutes is 288 polls/day
    // (86,400s / 300s); 500 items/day at a 100-item page only needs 5 pages, so the poll
    // cadence dominates: 288 pages/day * (100 * $0.005 per-page cost) = $144/day.
    const pollsPerDay = Math.ceil(86_400 / 300);
    expect(pollsPerDay).toBe(288);
    const pagesPerDay = Math.max(pollsPerDay, Math.ceil(500 / 100));
    expect(pagesPerDay).toBe(288);
    const expectedCostPerDay = pagesPerDay * (DEFAULT_PAGE_SIZE * RATE_CARD['x.mentions']);
    expect(expectedCostPerDay).toBe(144);

    expect(result.unit).toBe('credits');
    expect(result.perResource).toHaveLength(1);
    expect(result.perResource[0]).toMatchObject({
      id: 'x.mentions',
      pollsPerDay,
      pagesPerDay,
      costPerDay: expectedCostPerDay,
    });
    expect(result.totalPerDay).toBe(144);
    expect(result.capacityPerDay).toBeCloseTo(5_000 / 30, 6);
  });

  // ── outbound: reply_dm ───────────────────────────────────────────────────

  it('preflight warns about the 13x URL cost but never blocks on it', async () => {
    const ctx = ctxFor(shared);
    const withUrl = await connector.preflight(ctx, {
      id: 'oa_1',
      kind: 'reply_dm',
      conversationExternalId: 'dmconv_1',
      payload: { text: 'Check this out: https://example.com/promo' },
      idempotencyKey: 'k1',
      requestNonce: 'n1',
      requestedByUserId: 'u1',
    });
    expect(withUrl.ok).toBe(true);
    expect(
      (withUrl as { ok: true; warnings: string[] }).warnings.some((w) => w.includes('13x')),
    ).toBe(true);

    const withoutUrl = await connector.preflight(ctx, {
      id: 'oa_2',
      kind: 'reply_dm',
      conversationExternalId: 'dmconv_1',
      payload: { text: 'Thanks for reaching out!' },
      idempotencyKey: 'k2',
      requestNonce: 'n2',
      requestedByUserId: 'u1',
    });
    expect(withoutUrl).toEqual({ ok: true, warnings: [] });
  });

  it('preflight blocks on empty text and on a missing target', async () => {
    const ctx = ctxFor(shared);
    const empty = await connector.preflight(ctx, {
      id: 'oa_3',
      kind: 'reply_dm',
      conversationExternalId: 'dmconv_1',
      payload: { text: '   ' },
      idempotencyKey: 'k3',
      requestNonce: 'n3',
      requestedByUserId: 'u1',
    });
    expect(empty).toMatchObject({ ok: false, code: 'VALIDATION' });

    const noTarget = await connector.preflight(ctx, {
      id: 'oa_4',
      kind: 'reply_dm',
      payload: { text: 'hello' },
      idempotencyKey: 'k4',
      requestNonce: 'n4',
      requestedByUserId: 'u1',
    });
    expect(noTarget).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('executes a reply_dm and charges the URL-inflated cost when the text contains a link', async () => {
    const double = createXDouble({ totalMentions: 1, totalDms: 1 });
    const ctx = ctxFor(double);
    const before = await ctx.budget.snapshot();
    const result = await connector.execute(ctx, {
      id: 'oa_10',
      kind: 'reply_dm',
      conversationExternalId: 'dmconv_9-x_user_1',
      payload: { text: 'See https://example.com for details' },
      idempotencyKey: 'idem-1',
      requestNonce: 'n1',
      requestedByUserId: 'u1',
    });
    expect(result.externalId).toMatch(/^dm_sent_/);
    const after = await ctx.budget.snapshot();
    const usedBefore = before.windows.reduce((s, w) => s + w.used, 0);
    const usedAfter = after.windows.reduce((s, w) => s + w.used, 0);
    expect(usedAfter - usedBefore).toBeCloseTo(RATE_CARD.reply_dm_url, 6);
  });

  it('executes a plain reply_dm at the un-inflated cost', async () => {
    const double = createXDouble({ totalMentions: 1, totalDms: 1 });
    const ctx = ctxFor(double);
    const before = await ctx.budget.snapshot();
    await connector.execute(ctx, {
      id: 'oa_11',
      kind: 'reply_dm',
      conversationExternalId: 'dmconv_9-x_user_1',
      payload: { text: 'Thanks!' },
      idempotencyKey: 'idem-2',
      requestNonce: 'n2',
      requestedByUserId: 'u1',
    });
    const after = await ctx.budget.snapshot();
    const usedBefore = before.windows.reduce((s, w) => s + w.used, 0);
    const usedAfter = after.windows.reduce((s, w) => s + w.used, 0);
    expect(usedAfter - usedBefore).toBeCloseTo(RATE_CARD.reply_dm, 6);
  });

  // ── normalize ────────────────────────────────────────────────────────────

  it('normalizes a mention into a canonical person + message (purity: same input, same output)', () => {
    const nctx = createTestNormalizeCtx(xManifest, { accountExternalId: 'x_user_1' });
    const a = connector.normalize(KINDS.mention, xMention, nctx);
    const b = connector.normalize(KINDS.mention, xMention, nctx);
    expect(b).toEqual(a);
    expect(a).toHaveLength(2);
    const [person, message] = a;
    expect(person).toMatchObject({ kind: 'person', platform: 'X', externalId: 'author_42' });
    expect(message).toMatchObject({
      kind: 'message',
      platform: 'X',
      messageType: 'mention',
      direction: 'inbound',
      authorExternalId: 'author_42',
      conversationExternalId: '1963000000000000000',
      isDeleted: undefined,
    });
  });

  it('normalizes a DM event into a canonical person + message', () => {
    const nctx = createTestNormalizeCtx(xManifest, { accountExternalId: 'x_user_1' });
    const [person, message] = connector.normalize(KINDS.dm, xDmEvent, nctx);
    expect(person).toMatchObject({ kind: 'person', externalId: 'sender_9' });
    expect(message).toMatchObject({
      kind: 'message',
      messageType: 'dm',
      direction: 'inbound',
      conversationExternalId: 'dmconv_9-x_user_1',
      authorExternalId: 'sender_9',
    });
  });

  it('normalizes a deleted mention as a tombstone (isDeleted: true), never dropped', () => {
    const nctx = createTestNormalizeCtx(xManifest, { accountExternalId: 'x_user_1' });
    const entities = connector.normalize(KINDS.mention, xMentionDeleted, nctx);
    const message = entities.find((e) => e.kind === 'message');
    expect(message).toBeDefined();
    expect((message as { isDeleted?: boolean }).isDeleted).toBe(true);
  });

  it('refuses a drifted mention shape so core can quarantine it as SCHEMA_DRIFT', () => {
    const nctx = createTestNormalizeCtx(xManifest);
    expect(() => connector.normalize(KINDS.mention, xMentionDrift, nctx)).toThrow();
    expect(() => connector.normalize('x_unknown_kind', {}, nctx)).toThrow(NexusError);
  });

  // ── health ───────────────────────────────────────────────────────────────

  it('reports health as reconnect_required without throwing when the token is rejected', async () => {
    const down = ctxFor(createXDouble({ forceStatus: 401 }));
    const report = await connector.health(down);
    expect(report.status).toBe('reconnect_required');
  });

  it('reports health as down without throwing when the platform is unreachable', async () => {
    const unreachable = ctxFor(shared, {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const report = await connector.health(unreachable);
    expect(report.status).toBe('down');
    expect(Array.isArray(report.checks)).toBe(true);
  });
});
