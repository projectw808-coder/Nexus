/**
 * Keitaro's attribution sink (spec §8.6, ADR-019): a `CanonicalConversion` stamps campaign,
 * source, offer, affiliate network, creative, landing and geo onto a Deal record once, at
 * creation, and rolls up `payout` onto `Deal.amount`. The same `subid`+`tid` arrives repeatedly
 * as `lead -> sale -> rejected`; `KeitaroConversionState` is the ledger that makes each
 * transition idempotent and each reversal exact, regardless of replay or redelivery order.
 *
 * One Deal per `subid` (a click's whole conversion history — lead, then sale, maybe a later
 * chargeback — is one buyer journey), not one Deal per `subid`+`tid`. Multiple `tid`s under the
 * same `subid` each get their own ledger row and each contributes its own amount to the shared
 * Deal; a rejection on one `tid` reverses only that `tid`'s contribution.
 */
import { NexusError } from '@nexus/core';
import type { CanonicalConversion } from '@nexus/connector-sdk';
import {
  createRecord,
  emitTimelineEvent,
  loadAttributes,
  publishEvent,
  systemActorFor,
  updateRecord,
  type AttributeRow,
  type TenantDb,
  type TenantRuntime,
} from '@nexus/db';
import type { CanonicalSink, NormalizedBatch } from '../sink.ts';

export type AttributionSinkStats = {
  dealsCreated: number;
  applied: number;
  reversed: number;
  noop: number;
};

/** Statuses that currently count as confirmed revenue on the books. */
const PAYOUT_STATUSES = new Set(['sale', 'deposit']);

type DealShape = {
  objectTypeId: string;
  attributes: AttributeRow[];
  nameId: string;
  amountId: string;
  attribution: {
    campaign: string;
    source: string;
    offer: string;
    affiliateNetwork: string;
    creative: string;
    landing: string;
    geo: string;
  };
};

function centsOf(amount: number): number {
  return Math.round(amount * 100);
}

function dealNameFor(c: CanonicalConversion): string {
  const label = c.campaign?.name ?? c.offer?.name ?? 'Keitaro lead';
  return `${label} — ${c.subid.slice(0, 12)}`;
}

function geoLabelOf(c: CanonicalConversion): string | null {
  if (!c.geo) return null;
  return c.geo.region ? `${c.geo.country}/${c.geo.region}` : c.geo.country;
}

async function dealShapeFor(db: TenantDb, workspaceId: string): Promise<DealShape> {
  const objectType = await db.objectType.findFirst({ where: { workspaceId, apiSlug: 'deal' } });
  if (!objectType)
    throw new NexusError('INTERNAL', {
      message:
        'workspace has no Deal object type — ensureSystemObjects must run before syncing Keitaro',
    });
  const attributes = await loadAttributes(db, objectType.id);
  const bySlug = new Map(attributes.map((a) => [a.apiSlug, a]));
  const need = (slug: string): AttributeRow => {
    const a = bySlug.get(slug);
    if (!a)
      throw new NexusError('INTERNAL', {
        message: `Deal is missing its "${slug}" system attribute — run ensureSystemObjects to backfill it`,
      });
    return a;
  };
  return {
    objectTypeId: objectType.id,
    attributes,
    nameId: need('name').id,
    amountId: need('amount').id,
    attribution: {
      campaign: need('attribution_campaign').id,
      source: need('attribution_source').id,
      offer: need('attribution_offer').id,
      affiliateNetwork: need('attribution_affiliate_network').id,
      creative: need('attribution_creative').id,
      landing: need('attribution_landing').id,
      geo: need('attribution_geo').id,
    },
  };
}

async function ensureDeal(
  db: TenantDb,
  batch: NormalizedBatch,
  shape: DealShape,
  c: CanonicalConversion,
  stats: AttributionSinkStats,
): Promise<string> {
  const sibling = await db.keitaroConversionState.findFirst({
    where: {
      workspaceId: batch.workspaceId,
      connectionId: batch.connectionId,
      subid: c.subid,
      dealRecordId: { not: null },
    },
    select: { dealRecordId: true },
  });
  if (sibling?.dealRecordId) return sibling.dealRecordId;

  const actor = systemActorFor(batch.workspaceId, batch.connectionId);
  const created = await createRecord(db, actor, {
    objectTypeId: shape.objectTypeId,
    attributes: shape.attributes,
    input: {
      [shape.nameId]: dealNameFor(c),
      [shape.amountId]: 0,
      [shape.attribution.campaign]: c.campaign?.name ?? null,
      [shape.attribution.source]: c.source?.name ?? null,
      [shape.attribution.offer]: c.offer?.name ?? null,
      [shape.attribution.affiliateNetwork]: c.affiliateNetwork?.name ?? null,
      [shape.attribution.creative]: c.creative?.name ?? null,
      [shape.attribution.landing]: c.landing?.name ?? null,
      [shape.attribution.geo]: geoLabelOf(c),
    },
  });
  stats.dealsCreated += 1;
  return created.id;
}

/**
 * Apply one conversion's status transition. Reverses whatever this (subid, tid) previously
 * applied, then applies its new amount if the new status is a payout status — exact regardless
 * of how many times the status arrives, because it always reverses against the ledger's own
 * record of what IT applied, never a recomputation from the incoming payload.
 */
async function applyOne(
  db: TenantDb,
  batch: NormalizedBatch,
  shape: DealShape,
  c: CanonicalConversion,
  stats: AttributionSinkStats,
): Promise<string | null> {
  const key = {
    workspaceId_connectionId_subid_tid: {
      workspaceId: batch.workspaceId,
      connectionId: batch.connectionId,
      subid: c.subid,
      tid: c.tid,
    },
  };
  const existing = await db.keitaroConversionState.findUnique({ where: key });

  if (
    existing &&
    existing.lastConversionExternalId === c.externalId &&
    existing.lastStatus === c.status
  ) {
    stats.noop += 1;
    return existing.dealRecordId;
  }

  const dealRecordId = existing?.dealRecordId ?? (await ensureDeal(db, batch, shape, c, stats));

  const wasApplied = existing ? PAYOUT_STATUSES.has(existing.lastStatus) : false;
  const nowApplies = PAYOUT_STATUSES.has(c.status);
  const prevAppliedCents = existing?.appliedPayoutCents ?? 0;
  const newCents = centsOf(c.payout);
  const deltaCents = (nowApplies ? newCents : 0) - (wasApplied ? prevAppliedCents : 0);

  if (deltaCents !== 0) {
    const actor = systemActorFor(batch.workspaceId, batch.connectionId);
    const record = await db.record.findUniqueOrThrow({ where: { id: dealRecordId } });
    const values = record.values as Record<string, unknown>;
    const rawAmount = values[shape.amountId];
    const currentAmount = typeof rawAmount === 'number' ? rawAmount : 0;
    const nextAmount = (centsOf(currentAmount) + deltaCents) / 100;
    await updateRecord(db, actor, {
      recordId: dealRecordId,
      attributes: shape.attributes,
      input: { [shape.amountId]: nextAmount },
    });
    if (deltaCents > 0) stats.applied += 1;
    else stats.reversed += 1;
  } else {
    stats.noop += 1;
  }

  await db.keitaroConversionState.upsert({
    where: key,
    update: {
      dealRecordId,
      lastConversionExternalId: c.externalId,
      lastStatus: c.status,
      appliedPayoutCents: nowApplies ? newCents : 0,
      appliedCurrency: nowApplies ? c.currency : null,
    },
    create: {
      workspaceId: batch.workspaceId,
      connectionId: batch.connectionId,
      subid: c.subid,
      tid: c.tid,
      dealRecordId,
      lastConversionExternalId: c.externalId,
      lastStatus: c.status,
      appliedPayoutCents: nowApplies ? newCents : 0,
      appliedCurrency: nowApplies ? c.currency : null,
    },
  });

  await emitTimelineEvent(db, {
    workspaceId: batch.workspaceId,
    dedupeKey: `keitaro:${batch.connectionId}:${c.subid}:${c.tid}:${c.externalId}:${c.status}`,
    type: 'DEAL_EVENT',
    occurredAt: c.postbackAt,
    recordId: dealRecordId,
    platform: 'KEITARO',
    connectionId: batch.connectionId,
    summary: `Keitaro conversion ${c.status}${nowApplies ? ` — ${c.currency} ${c.payout.toFixed(2)}` : ''}`,
    payload: {
      subid: c.subid,
      tid: c.tid,
      status: c.status,
      previousStatus: existing?.lastStatus ?? null,
      payout: c.payout,
      currency: c.currency,
      deltaCents,
    },
  });

  return dealRecordId;
}

export function createAttributionSink(
  runtime: TenantRuntime,
  opts: {
    onChange?: (change: { workspaceId: string; connectionId: string; recordIds: string[] }) => void;
  } = {},
): CanonicalSink & { stats: AttributionSinkStats } {
  const stats: AttributionSinkStats = { dealsCreated: 0, applied: 0, reversed: 0, noop: 0 };
  const shapeCache = new Map<string, DealShape>();

  return {
    stats,
    async materialize(batch: NormalizedBatch) {
      const conversions: CanonicalConversion[] = [];
      for (const item of batch.items)
        for (const e of item.entities) if (e.kind === 'conversion') conversions.push(e);
      if (conversions.length === 0) return;

      const actor = systemActorFor(batch.workspaceId, batch.connectionId);
      const touched = new Set<string>();
      await runtime.withTenant(actor, async (db) => {
        let shape = shapeCache.get(batch.workspaceId);
        if (!shape) {
          shape = await dealShapeFor(db, batch.workspaceId);
          shapeCache.set(batch.workspaceId, shape);
        }
        for (const c of conversions) {
          const dealRecordId = await applyOne(db, batch, shape, c, stats);
          if (dealRecordId) touched.add(dealRecordId);
        }
        if (touched.size)
          await publishEvent(db, {
            workspaceId: batch.workspaceId,
            topic: 'record.changed',
            payload: { ids: [...touched], connectionId: batch.connectionId },
          });
      });
      if (touched.size)
        opts.onChange?.({
          workspaceId: batch.workspaceId,
          connectionId: batch.connectionId,
          recordIds: [...touched],
        });
    },
  };
}
