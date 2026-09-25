/**
 * Phase 8 (spec §8.6, ADR-019): a Keitaro conversion arrives repeatedly as its status changes,
 * and the sink must add revenue once and reverse it exactly once — never drift, never double
 * apply, and never lose the attribution stamped at Deal creation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalConversion } from '@nexus/connector-sdk';
import { systemActorFor, type Actor } from '@nexus/db';
import { createTestDatabase, type TestDatabase } from '@nexus/db/testing';
import type { NormalizedBatch } from '../sink.ts';
import { createAttributionSink } from './attribution.ts';

let db: TestDatabase;
let owner: Actor;
let workspaceId: string;
const connectionId = 'conn_keitaro_test';

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({
    data: { email: 'owner@attribution.test', name: 'Owner' },
  });
  const ws = await db.tenancy.createWorkspace({
    name: 'Attribution',
    slug: 'attribution',
    ownerUserId: u.id,
  });
  workspaceId = ws.id;
  owner = { ...systemActorFor(ws.id), userId: u.id, actorType: 'USER' };
  await db.runtime.withTenant(owner, (t) =>
    t.connection.create({
      data: {
        id: connectionId,
        workspaceId,
        platform: 'KEITARO',
        label: 'Keitaro — tracker.example.test',
        accountExternalId: 'tracker.example.test',
        accountName: 'tracker.example.test',
        apiVersion: 'admin_api/v1',
        tokenRef: 'vault_test',
        ownerUserId: u.id,
      },
    }),
  );
});
afterAll(async () => db.close());

function conversion(overrides: Partial<CanonicalConversion>): CanonicalConversion {
  return {
    kind: 'conversion',
    platform: 'KEITARO',
    externalId: overrides.externalId ?? 'ext_1',
    occurredAt: new Date('2026-09-24T10:00:00Z'),
    sourceUrl: null,
    raw: {},
    subid: 'click_abc',
    tid: 'tx_1',
    status: 'lead',
    previousStatus: null,
    payout: 0,
    currency: 'USD',
    subIds: {},
    campaign: { externalId: 'c1', name: 'Spring Promo' },
    source: { externalId: 's1', name: 'push-network' },
    offer: { externalId: 'o1', name: 'Weight Loss Offer' },
    affiliateNetwork: { externalId: 'a1', name: 'MaxBounty' },
    stream: null,
    landing: null,
    geo: { country: 'US' },
    device: null,
    creative: null,
    clickedAt: new Date('2026-09-24T09:55:00Z'),
    postbackAt: new Date('2026-09-24T10:00:00Z'),
    ...overrides,
  };
}

function batchOf(...entities: CanonicalConversion[]): NormalizedBatch {
  return {
    workspaceId,
    connectionId,
    platform: 'KEITARO',
    items: entities.map((e, i) => ({
      objectId: `obj_${i}_${e.externalId}`,
      kind: 'keitaro_conversion',
      externalId: e.externalId,
      entities: [e],
    })),
  };
}

async function dealAmount(recordId: string): Promise<number> {
  const record = await db.runtime.withTenant(owner, (t) =>
    t.record.findUniqueOrThrow({ where: { id: recordId } }),
  );
  const objectType = await db.runtime.withTenant(owner, (t) =>
    t.objectType.findFirstOrThrow({ where: { workspaceId, apiSlug: 'deal' } }),
  );
  const amountAttr = await db.runtime.withTenant(owner, (t) =>
    t.attribute.findFirstOrThrow({
      where: { workspaceId, objectTypeId: objectType.id, apiSlug: 'amount' },
    }),
  );
  const values = record.values as Record<string, unknown>;
  const raw = values[amountAttr.id];
  return typeof raw === 'number' ? raw : 0;
}

describe('Keitaro attribution sink', () => {
  it('creates a Deal on first sight, stamps attribution once, adds on sale and reverses on rejection', async () => {
    const sink = createAttributionSink(db.runtime);

    await sink.materialize(batchOf(conversion({ externalId: 'ev_1', status: 'lead', payout: 0 })));
    expect(sink.stats.dealsCreated).toBe(1);

    const state1 = await db.runtime.withTenant(owner, (t) =>
      t.keitaroConversionState.findFirstOrThrow({
        where: { workspaceId, connectionId, subid: 'click_abc', tid: 'tx_1' },
      }),
    );
    const dealRecordId = state1.dealRecordId!;
    expect(dealRecordId).toBeTruthy();
    expect(await dealAmount(dealRecordId)).toBe(0);

    const deal = await db.runtime.withTenant(owner, (t) =>
      t.record.findUniqueOrThrow({ where: { id: dealRecordId } }),
    );
    const objectType = await db.runtime.withTenant(owner, (t) =>
      t.objectType.findFirstOrThrow({ where: { workspaceId, apiSlug: 'deal' } }),
    );
    const attrs = await db.runtime.withTenant(owner, (t) =>
      t.attribute.findMany({ where: { workspaceId, objectTypeId: objectType.id } }),
    );
    const bySlug = Object.fromEntries(attrs.map((a) => [a.apiSlug, a.id]));
    const values = deal.values as Record<string, unknown>;
    expect(values[bySlug['attribution_campaign']!]).toBe('Spring Promo');
    expect(values[bySlug['attribution_source']!]).toBe('push-network');
    expect(values[bySlug['attribution_affiliate_network']!]).toBe('MaxBounty');
    expect(values[bySlug['attribution_geo']!]).toBe('US');

    // sale confirms the payout — it lands on the Deal.
    await sink.materialize(
      batchOf(
        conversion({ externalId: 'ev_2', status: 'sale', previousStatus: 'lead', payout: 42.5 }),
      ),
    );
    expect(sink.stats.applied).toBe(1);
    expect(await dealAmount(dealRecordId)).toBe(42.5);
    expect(sink.stats.dealsCreated).toBe(1); // no second Deal for the same subid

    // Attribution is immutable after creation: a later conversion under the same subid/tid must
    // never overwrite it, even if the platform's campaign attribution changed since.
    await sink.materialize(
      batchOf(
        conversion({
          externalId: 'ev_2b',
          status: 'sale',
          previousStatus: 'sale',
          payout: 42.5,
          campaign: { externalId: 'c2', name: 'Different Campaign' },
        }),
      ),
    );
    const dealAfter = await db.runtime.withTenant(owner, (t) =>
      t.record.findUniqueOrThrow({ where: { id: dealRecordId } }),
    );
    expect((dealAfter.values as Record<string, unknown>)[bySlug['attribution_campaign']!]).toBe(
      'Spring Promo',
    );

    // rejected reverses exactly what this (subid, tid) applied — never a recomputation.
    await sink.materialize(
      batchOf(
        conversion({ externalId: 'ev_3', status: 'rejected', previousStatus: 'sale', payout: 0 }),
      ),
    );
    expect(sink.stats.reversed).toBe(1);
    expect(await dealAmount(dealRecordId)).toBe(0);

    // A redelivery of the exact same event (same externalId, same status) is a pure no-op.
    await sink.materialize(
      batchOf(
        conversion({ externalId: 'ev_3', status: 'rejected', previousStatus: 'sale', payout: 0 }),
      ),
    );
    expect(sink.stats.noop).toBeGreaterThan(0);
    expect(await dealAmount(dealRecordId)).toBe(0);
  });

  it('rolls up several tids under one subid onto the same Deal, and reverses only the rejected one', async () => {
    const sink = createAttributionSink(db.runtime);
    await sink.materialize(
      batchOf(
        conversion({
          externalId: 'up_1',
          subid: 'click_multi',
          tid: 'tx_a',
          status: 'sale',
          payout: 20,
        }),
      ),
    );
    const state = await db.runtime.withTenant(owner, (t) =>
      t.keitaroConversionState.findFirstOrThrow({
        where: { workspaceId, connectionId, subid: 'click_multi', tid: 'tx_a' },
      }),
    );
    const dealRecordId = state.dealRecordId!;
    expect(await dealAmount(dealRecordId)).toBe(20);

    await sink.materialize(
      batchOf(
        conversion({
          externalId: 'up_2',
          subid: 'click_multi',
          tid: 'tx_b',
          status: 'sale',
          payout: 15,
        }),
      ),
    );
    const state2 = await db.runtime.withTenant(owner, (t) =>
      t.keitaroConversionState.findFirstOrThrow({
        where: { workspaceId, connectionId, subid: 'click_multi', tid: 'tx_b' },
      }),
    );
    expect(state2.dealRecordId).toBe(dealRecordId); // same Deal, not a second one
    expect(await dealAmount(dealRecordId)).toBe(35);

    await sink.materialize(
      batchOf(
        conversion({
          externalId: 'up_3',
          subid: 'click_multi',
          tid: 'tx_a',
          status: 'rejected',
          previousStatus: 'sale',
          payout: 0,
        }),
      ),
    );
    expect(await dealAmount(dealRecordId)).toBe(15); // only tx_a's 20 was reversed
  });
});
