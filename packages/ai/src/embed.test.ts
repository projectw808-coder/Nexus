/** §13.6/§13.7: chunking, the Embedding upsert, semantic search and the bio-similarity primitive. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDb } from '@nexus/db';
import type { AiSettings } from './budget.ts';
import type { AiDeps } from './context.ts';
import { bioEmbeddingSimilarity, chunkText, cosineSimilarity, embedAndStore } from './embed.ts';
import { deterministicVector, mockAiModel, type MockAiModel } from './model.ts';
import { semanticSearch } from './search.ts';
import { createFixture, fixedClock, settings, type Fixture } from './testing/fixtures.ts';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture('embed');
}, 120_000);
afterAll(async () => {
  await f.close();
});

function deps(db: TenantDb, model: MockAiModel, s: AiSettings = settings()): AiDeps {
  return { db, model, now: fixedClock, settings: s };
}

describe('chunkText', () => {
  it('returns one chunk for short text and overlapping chunks for long text', () => {
    expect(chunkText('hello')).toEqual(['hello']);
    expect(chunkText('   ')).toEqual([]);
    const long = 'a'.repeat(2500);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // Overlap means the joined length exceeds the original.
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBeGreaterThan(long.length);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for orthogonal, null for degenerate input', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
  });
});

describe('bioEmbeddingSimilarity', () => {
  it('returns null when either bio is blank, and a number otherwise', async () => {
    const model = mockAiModel();
    expect(await bioEmbeddingSimilarity(model, '', 'something')).toBeNull();
    expect(await bioEmbeddingSimilarity(model, '   ', 'something')).toBeNull();
    expect(model.calls.embed).toBe(0);

    const same = await bioEmbeddingSimilarity(model, 'growth marketer', 'growth marketer');
    expect(same).toBeCloseTo(1, 6);
    const different = await bioEmbeddingSimilarity(model, 'growth marketer', 'welder in Ohio');
    expect(different).not.toBeNull();
    expect(different!).toBeLessThan(same!);
  });
});

describe('embedAndStore', () => {
  it('upserts one Embedding row per chunk, keyed for idempotency', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      const first = await embedAndStore(deps(db, model), {
        workspaceId: f.workspaceId,
        sourceType: 'note',
        sourceId: 'note-1',
        text: 'b'.repeat(2500),
      });
      expect(first.chunks).toBeGreaterThan(1);
      const rows = await db.embedding.findMany({
        where: { workspaceId: f.workspaceId, sourceType: 'note', sourceId: 'note-1' },
        orderBy: { chunkIndex: 'asc' },
      });
      expect(rows).toHaveLength(first.chunks);
      expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));
      expect(rows[0]!.model).toBe('mock');

      // Re-embedding the same source replaces rather than duplicates, and prunes stale chunks.
      const second = await embedAndStore(deps(db, model), {
        workspaceId: f.workspaceId,
        sourceType: 'note',
        sourceId: 'note-1',
        text: 'short now',
      });
      expect(second.chunks).toBe(1);
      const after = await db.embedding.findMany({
        where: { workspaceId: f.workspaceId, sourceType: 'note', sourceId: 'note-1' },
      });
      expect(after).toHaveLength(1);
      expect(after[0]!.text).toBe('short now');
    });
  });

  it('redacts PII in the stored chunk text', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await embedAndStore(deps(db, model), {
        workspaceId: f.workspaceId,
        sourceType: 'note',
        sourceId: 'note-pii',
        text: 'Call ada@example.com about the quote.',
      });
      const row = await db.embedding.findFirstOrThrow({
        where: { sourceType: 'note', sourceId: 'note-pii' },
      });
      expect(row.text).toContain('[REDACTED_EMAIL]');
      expect(row.text).not.toContain('ada@example.com');
    });
  });

  it('is a no-op for blank text and never calls the model', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      expect(
        await embedAndStore(deps(db, model), {
          workspaceId: f.workspaceId,
          sourceType: 'note',
          sourceId: 'blank',
          text: '   ',
        }),
      ).toEqual({ chunks: 0 });
    });
    expect(model.calls.embed).toBe(0);
  });

  it('rejects a model whose vectors are the wrong width', async () => {
    const model = mockAiModel({ embed: (texts) => texts.map(() => [1, 2, 3]) });
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        embedAndStore(deps(db, model), {
          workspaceId: f.workspaceId,
          sourceType: 'note',
          sourceId: 'bad-dims',
          text: 'hello',
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('kill switch: no model call', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        embedAndStore(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          sourceType: 'note',
          sourceId: 'blocked',
          text: 'hello',
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.embed).toBe(0);
  });
});

describe('semanticSearch', () => {
  it('finds the source whose embedding matches the query', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      await db.embedding.deleteMany({ where: { workspaceId: f.workspaceId } });
      await embedAndStore(deps(db, model), {
        workspaceId: f.workspaceId,
        sourceType: 'message',
        sourceId: 'msg-pricing',
        text: 'annual pricing for the enterprise plan',
      });
      await embedAndStore(deps(db, model), {
        workspaceId: f.workspaceId,
        sourceType: 'message',
        sourceId: 'msg-shipping',
        text: 'warehouse logistics and pallet shipping',
      });

      const hits = await semanticSearch(deps(db, model), {
        workspaceId: f.workspaceId,
        query: 'annual pricing for the enterprise plan',
        limit: 5,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.sourceId).toBe('msg-pricing');
      expect(hits[0]!.snippet).toContain('pricing');
      expect(hits[0]!.score).toBeGreaterThan(0);
    });
  });

  it('returns nothing for a blank query without calling the model', async () => {
    const model = mockAiModel();
    await f.db.runtime.withTenant(f.actor, async (db) => {
      expect(
        await semanticSearch(deps(db, model), { workspaceId: f.workspaceId, query: '  ' }),
      ).toEqual([]);
    });
    expect(model.calls.embed).toBe(0);
  });

  it('kill switch: no model call', async () => {
    const model = mockAiModel();
    await expect(
      f.db.runtime.withTenant(f.actor, (db) =>
        semanticSearch(deps(db, model, settings({ killSwitch: true })), {
          workspaceId: f.workspaceId,
          query: 'pricing',
        }),
      ),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(model.calls.embed).toBe(0);
  });

  it('uses the same vectors the db layer will compare against', () => {
    // Guards the assumption behind the search test: the mock embedder is a pure function of text.
    expect(deterministicVector('annual pricing')).toEqual(deterministicVector('annual pricing'));
  });
});
