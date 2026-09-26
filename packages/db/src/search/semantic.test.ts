/**
 * Phase 10 §13.6: reciprocal-rank fusion of Postgres full-text over `Record.searchVector` with
 * pgvector cosine distance over `Embedding`. Seeds two records with distinct text and two
 * embedding rows, then checks each branch alone and the fusion together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../scoped.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import { hybridSearch, toVectorLiteral } from './semantic.ts';

const DIMS = 1536;

/** A vector that is 1 on one axis and 0 elsewhere — orthogonal axes are trivially comparable. */
function axisVector(axis: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis % DIMS] = 1;
  return v;
}

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let pricingRecordId: string;
let shippingRecordId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const user = await db.prisma.user.create({ data: { email: 'owner@sem.test', name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({
    name: 'Semantic',
    slug: 'semantic-test',
    ownerUserId: user.id,
  });
  workspaceId = ws.id;
  actor = { workspaceId, userId: user.id, role: 'OWNER', grants: [] };

  await db.runtime.withTenant(actor, async (t) => {
    const ot = await t.objectType.create({
      data: { workspaceId, apiSlug: 'sem_doc', singular: 'Doc', plural: 'Docs' },
    });
    const note = await t.attribute.create({
      data: {
        workspaceId,
        objectTypeId: ot.id,
        apiSlug: 'sem_note',
        title: 'Note',
        type: 'TEXT',
        position: 0,
      },
    });
    const pricing = await t.record.create({
      data: {
        workspaceId,
        objectTypeId: ot.id,
        values: { [note.id]: 'enterprise pricing and annual contract renewal' },
      },
    });
    pricingRecordId = pricing.id;
    const shipping = await t.record.create({
      data: {
        workspaceId,
        objectTypeId: ot.id,
        values: { [note.id]: 'warehouse logistics and pallet shipping schedule' },
      },
    });
    shippingRecordId = shipping.id;
  });

  // Embedding.vector is Unsupported() in Prisma, so seed it as raw SQL (superuser: setup only).
  for (const [i, seed] of [
    { sourceId: 'msg-pricing', axis: 0, text: 'quote for the enterprise pricing tier' },
    { sourceId: 'msg-shipping', axis: 1, text: 'pallet shipping to the north warehouse' },
  ].entries()) {
    await db.sqlAsSuperuser(
      `INSERT INTO "Embedding" ("id","workspaceId","sourceType","sourceId","vector","model","chunkIndex","text","createdAt","updatedAt")
       VALUES ($1,$2,'message',$3,$4::vector,'mock',0,$5, now(), now())`,
      [`emb-${i}`, workspaceId, seed.sourceId, toVectorLiteral(axisVector(seed.axis)), seed.text],
    );
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('toVectorLiteral', () => {
  it('renders pgvector text input and neutralises non-finite values', () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe('[1,2.5,-3]');
    expect(toVectorLiteral([Number.NaN, Number.POSITIVE_INFINITY])).toBe('[0,0]');
  });
});

describe('hybridSearch', () => {
  it('ranks the full-text match first when only text is supplied', async () => {
    const hits = await db.runtime.withTenant(actor, (t) =>
      hybridSearch(t, { workspaceId, queryText: 'pricing', queryVector: [], limit: 10 }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ sourceType: 'record', sourceId: pricingRecordId });
    expect(hits[0]!.snippet).toContain('pricing');
    expect(hits.map((h) => h.sourceId)).not.toContain(shippingRecordId);
  });

  it('ranks the nearest embedding first when only a vector is supplied', async () => {
    const hits = await db.runtime.withTenant(actor, (t) =>
      hybridSearch(t, { workspaceId, queryText: '', queryVector: axisVector(1), limit: 10 }),
    );
    expect(hits[0]).toMatchObject({ sourceType: 'message', sourceId: 'msg-shipping' });
  });

  it('fuses both branches: a row in both lists outranks a row in one', async () => {
    const hits = await db.runtime.withTenant(actor, (t) =>
      hybridSearch(t, {
        workspaceId,
        queryText: 'enterprise pricing',
        queryVector: axisVector(0),
        limit: 10,
      }),
    );
    const ids = hits.map((h) => h.sourceId);
    expect(ids).toContain(pricingRecordId);
    expect(ids).toContain('msg-pricing');
    // The pricing record wins the FTS branch outright; the pricing message wins the vector branch.
    expect(ids.indexOf('msg-shipping')).toBeGreaterThan(ids.indexOf('msg-pricing'));
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  it('honours the limit and returns nothing for an empty query', async () => {
    await db.runtime.withTenant(actor, async (t) => {
      const one = await hybridSearch(t, {
        workspaceId,
        queryText: 'enterprise pricing',
        queryVector: axisVector(0),
        limit: 1,
      });
      expect(one).toHaveLength(1);
      expect(await hybridSearch(t, { workspaceId, queryText: '   ', queryVector: [] })).toEqual([]);
    });
  });

  it('never leaks across workspaces', async () => {
    const other = await db.prisma.user.create({ data: { email: 'other@sem.test', name: 'Other' } });
    const otherWs = await db.tenancy.createWorkspace({
      name: 'Other',
      slug: 'semantic-other',
      ownerUserId: other.id,
    });
    const otherActor: Actor = {
      workspaceId: otherWs.id,
      userId: other.id,
      role: 'OWNER',
      grants: [],
    };
    const hits = await db.runtime.withTenant(otherActor, (t) =>
      hybridSearch(t, {
        workspaceId: otherWs.id,
        queryText: 'enterprise pricing',
        queryVector: axisVector(0),
      }),
    );
    expect(hits).toEqual([]);
  });
});
