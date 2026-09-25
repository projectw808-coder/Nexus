/**
 * Phase 7 acceptance (spec §16): inbox p95 load < 500 ms with 50k conversations. The load
 * fixture inserts 50,000 conversations (one message and one identity each) in SQL; the list
 * procedure is then called through the in-process tRPC caller with the filter mixes the UI
 * sends, and the 95th percentile of wall time must stay under 500 ms — on PGlite, which is
 * slower than a real Postgres.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertConnection } from '@nexus/db';
import { seedInboxLoad } from '@nexus/db/testing';
import { seedWorkspaces, type Seed } from './testing';

const COUNT = Number(process.env['INBOX_LOAD_COUNT'] ?? 50_000);

let seed: Seed;

beforeAll(async () => {
  seed = await seedWorkspaces();
  const conn = await seed.db.runtime.withTenant(
    seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
    async (db) => {
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
        label: 'Mock — load',
        accountExternalId: 'acct_load',
        accountName: 'Load',
        scopesGranted: ['read:posts'],
        scopesRequired: ['read:posts'],
        capabilities: ['read:posts'],
        apiVersion: '2026-09',
        tokenRef,
        ownerUserId: seed.users.alice.id,
      });
    },
  );
  await seedInboxLoad(seed.db.runtime, {
    workspaceId: seed.acme.id,
    connectionId: conn.id,
    count: COUNT,
    assigneeIds: [seed.users.alice.id, seed.users.carol.id],
  });
}, 600_000);

afterAll(async () => {
  await seed?.db.close();
});

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

describe(`inbox with ${COUNT.toLocaleString()} conversations`, () => {
  it('lists under 500 ms at p95 across the filter mixes the UI sends', async () => {
    const owner = seed.caller(seed.users.alice, 'acme');
    const total = await seed.db.runtime.withSystem((s) =>
      s.conversation.count({ where: { workspaceId: seed.acme.id } }),
    );
    expect(total).toBeGreaterThanOrEqual(COUNT);
    const mixes = [
      { status: 'OPEN' as const, limit: 50 },
      { status: 'OPEN' as const, platform: 'INSTAGRAM' as const, limit: 50 },
      { status: 'OPEN' as const, assignee: 'me', limit: 50 },
      { status: 'OPEN' as const, assignee: 'unassigned', unread: true, limit: 50 },
      { status: 'OPEN' as const, sla: 'breached' as const, limit: 50 },
      { status: 'CLOSED' as const, limit: 50 },
      { status: 'SNOOZED' as const, limit: 50 },
      { status: 'OPEN' as const, tag: 'vip', limit: 50 },
      { status: 'OPEN' as const, kind: 'DM' as const, limit: 50 },
    ];
    // Warm the connection once, then measure.
    await owner.conversation.list({ status: 'OPEN', limit: 50 });
    const samples: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const mix = mixes[i % mixes.length]!;
      const t0 = performance.now();
      const page = await owner.conversation.list({
        ...mix,
        ...(i % 9 === 0 && cursor ? { cursor } : {}),
      });
      samples.push(performance.now() - t0);
      if (i % 9 === 0) cursor = page.nextCursor;
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.counts.total).toBeGreaterThan(0);
    }
    const stats = {
      p50: Math.round(
        p95(
          samples
            .slice()
            .sort((a, b) => a - b)
            .slice(0, Math.ceil(samples.length / 2)),
        ),
      ),
      p95: Math.round(p95(samples)),
      max: Math.round(Math.max(...samples)),
    };
    // vitest swallows console output from forked workers; keep the numbers on disk too.
    mkdirSync('test-results', { recursive: true });
    writeFileSync(
      'test-results/inbox-perf.json',
      JSON.stringify({ conversations: total, samples: samples.length, ...stats }, null, 2),
    );
    expect(stats.p95, JSON.stringify(stats)).toBeLessThan(500);
  }, 600_000);

  it('opening a thread and its context stays fast too', async () => {
    const owner = seed.caller(seed.users.alice, 'acme');
    const page = await owner.conversation.list({ status: 'OPEN', limit: 20 });
    const samples: number[] = [];
    for (const c of page.items) {
      const t0 = performance.now();
      await owner.conversation.get({ id: c.id });
      await owner.conversation.context({ id: c.id });
      samples.push(performance.now() - t0);
    }
    expect(p95(samples)).toBeLessThan(500);
  }, 120_000);
});
