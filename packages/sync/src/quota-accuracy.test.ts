/**
 * Phase 9 acceptance (spec §16): the pre-connect quota simulator's estimate for a seeded volume
 * must land within 20% of what a connection actually spends fetching that volume over a day.
 * `simulateQuota` (packages/connectors/sdk) is pure — it has never been checked against a real
 * connector's real budget accounting until now. Delta polls fetch new items evenly (a steady
 * trickle, not a burst), matching the assumption the simulator's formula makes.
 */
import { describe, expect, it } from 'vitest';
import { createMockConnector, createMockPlatform, mockManifest } from '@nexus/connector-mock';
import { simulateQuota } from '@nexus/connector-sdk';
import { createTestConnCtx } from '@nexus/connector-sdk/testing';

describe('quota simulator accuracy', () => {
  it('projects within 20% of observed consumption for a seeded 24h volume', async () => {
    const platform = createMockPlatform({ totalObjects: 5, accounts: 1 });
    const config = { baseUrl: platform.baseUrl };
    const connector = createMockConnector(config);
    const ctx = createTestConnCtx({
      manifest: mockManifest,
      fetch: platform.fetch,
      config,
      accountExternalId: 'acct_1',
      token: {
        accessToken: platform.issueToken().accessToken,
        scopes: ['read:posts', 'read:comments', 'write:reply_comment'],
        tokenType: 'Bearer',
        raw: {},
      },
    });

    const intervalSeconds = 3600; // hourly delta poll
    const pollsPerDay = Math.ceil(86_400 / intervalSeconds); // 24
    const itemsPerDay = 96; // 4 new comments per poll — a steady trickle, not a burst
    const pageSize = 25; // comfortably above one poll's worth, so each poll costs one page

    const before = await ctx.budget.snapshot();
    let highWaterMark: Date | null = null;
    for (let poll = 0; poll < pollsPerDay; poll++) {
      for (let i = 0; i < itemsPerDay / pollsPerDay; i++) await platform.newComment('acct_1');
      const page = await connector.fetchPage(ctx, {
        id: 'mock.comments',
        since: null,
        highWaterMark,
        pageSize,
      });
      highWaterMark = page.highWaterMark ?? highWaterMark;
    }
    const after = await ctx.budget.snapshot();
    const observedPerDay =
      after.windows.reduce((s, w) => s + w.used, 0) -
      before.windows.reduce((s, w) => s + w.used, 0);

    const projected = simulateQuota({
      manifest: mockManifest,
      resources: [{ id: 'mock.comments', intervalSeconds }],
      volume: { 'mock.comments': { itemsPerDay, pageSize } },
    });

    expect(observedPerDay).toBeGreaterThan(0);
    const ratio = projected.totalPerDay / observedPerDay;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });
});
