import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './scoped.ts';
import { createTestDatabase, type TestDatabase } from './testing/pglite.ts';
import { sweepSnoozed } from './inbox.ts';
import { closeEventListener, publishEvent, subscribeEvents, type NexusEvent } from './realtime.ts';

let db: TestDatabase;
let actor: Actor;
let ws: { id: string };

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@rt.test', name: 'Owner' } });
  ws = await db.tenancy.createWorkspace({ name: 'RT', slug: 'realtime', ownerUserId: u.id });
  actor = { workspaceId: ws.id, userId: u.id, role: 'OWNER', grants: [] };
});
afterAll(async () => {
  await closeEventListener();
  await db.close();
});

describe('realtime', () => {
  it('delivers an event published inside a committed tenant transaction, filtered by workspace', async () => {
    const got: NexusEvent[] = [];
    const unsubscribe = await subscribeEvents((e) => got.push(e), { workspaceId: ws.id });
    const other: NexusEvent[] = [];
    const unsubOther = await subscribeEvents((e) => other.push(e), { workspaceId: 'someone-else' });
    await db.runtime.withTenant(actor, (t) =>
      publishEvent(t, {
        workspaceId: ws.id,
        topic: 'conversation.changed',
        payload: { ids: ['c1'] },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      workspaceId: ws.id,
      topic: 'conversation.changed',
      payload: { ids: ['c1'] },
    });
    expect(other).toHaveLength(0);
    unsubscribe();
    unsubOther();
    await db.runtime.withTenant(actor, (t) =>
      publishEvent(t, { workspaceId: ws.id, topic: 'conversation.changed', payload: {} }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
  });

  it('a rolled-back transaction publishes nothing', async () => {
    const got: NexusEvent[] = [];
    const unsubscribe = await subscribeEvents((e) => got.push(e), { workspaceId: ws.id });
    await db.runtime
      .withTenant(actor, async (t) => {
        await publishEvent(t, { workspaceId: ws.id, topic: 'x', payload: {} });
        throw new Error('boom');
      })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(0);
    unsubscribe();
  });
});

describe('snooze sweep', () => {
  it('reopens expired snoozes and announces them', async () => {
    const conn = await db.runtime.withTenant(actor, (t) =>
      t.connection.create({
        data: {
          workspaceId: ws.id,
          platform: 'MOCK',
          label: 'Mock',
          accountExternalId: 'acct_rt',
          accountName: 'Mock',
          apiVersion: '2026-09',
          tokenRef: 'vault:x',
          ownerUserId: actor.userId,
          scopesGranted: [],
          scopesRequired: [],
          capabilities: [],
        },
        select: { id: true },
      }),
    );
    const mk = (externalId: string, until: Date) =>
      db.runtime.withTenant(actor, (t) =>
        t.conversation.create({
          data: {
            workspaceId: ws.id,
            connectionId: conn.id,
            platform: 'MOCK',
            kind: 'DM',
            externalId,
            status: 'SNOOZED',
            snoozedUntil: until,
            lastMessageAt: new Date(),
          },
          select: { id: true },
        }),
      );
    const past = await mk('dm_past', new Date(Date.now() - 60_000));
    const future = await mk('dm_future', new Date(Date.now() + 3600_000));
    const got: NexusEvent[] = [];
    const unsubscribe = await subscribeEvents((e) => got.push(e), { workspaceId: ws.id });
    const r = await sweepSnoozed(db.runtime);
    expect(r.reopened).toBe(1);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(got[0]?.payload).toEqual({ ids: [past.id], reason: 'unsnoozed' });
    const rows = await db.runtime.withTenant(actor, (t) =>
      t.conversation.findMany({
        where: { id: { in: [past.id, future.id] } },
        orderBy: { externalId: 'asc' },
      }),
    );
    expect(rows.map((c) => [c.externalId, c.status])).toEqual([
      ['dm_future', 'SNOOZED'],
      ['dm_past', 'OPEN'],
    ]);
    unsubscribe();
  });
});
