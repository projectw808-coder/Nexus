/**
 * Embeddings (spec §13.6, §13.7). `Embedding.vector` is `Unsupported("vector(1536)")` in Prisma,
 * so the upsert is raw SQL — the one place in this package that needs it.
 */
import { NexusError } from '@nexus/core';
import { toVectorLiteral } from '@nexus/db';
import type { TenantDb } from '@nexus/db';
import { assertAllowed, checkAiAllowed, recordAiUsage } from './budget.ts';
import type { AiDeps } from './context.ts';
import { EMBEDDING_DIMENSIONS, type AiModel } from './model.ts';
import { redactPii } from './redact.ts';

export const CHUNK_CHARS = 1000;
export const CHUNK_OVERLAP = 100;

/** Fixed-size chunks with a little overlap so a sentence straddling a boundary is still findable. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += step) {
    const piece = clean.slice(i, i + size).trim();
    if (piece) out.push(piece);
    if (i + size >= clean.length) break;
  }
  return out;
}

function assertDimensions(vector: number[], index: number): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new NexusError('VALIDATION', {
      message: `embedding ${index} has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      context: { reason: 'The configured embedding model does not match the schema.' },
      details: { expected: EMBEDDING_DIMENSIONS, received: vector.length },
    });
  }
}

/** Upsert one chunk row. Keyed by (workspaceId, sourceType, sourceId, model, chunkIndex). */
async function upsertChunk(
  db: TenantDb,
  row: {
    workspaceId: string;
    sourceType: string;
    sourceId: string;
    model: string;
    chunkIndex: number;
    text: string;
    vector: number[];
  },
): Promise<void> {
  // nexus-allow-raw: Embedding.vector is Unsupported("vector(1536)") — Prisma cannot write it.
  // Scoped to the actor's workspaceId explicitly, on top of RLS.
  await db.$executeRaw`
    INSERT INTO "Embedding" ("id", "workspaceId", "sourceType", "sourceId", "vector", "model", "chunkIndex", "text", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${row.workspaceId}, ${row.sourceType}, ${row.sourceId},
            ${toVectorLiteral(row.vector)}::vector, ${row.model}, ${row.chunkIndex}, ${row.text}, now(), now())
    ON CONFLICT ("workspaceId", "sourceType", "sourceId", "model", "chunkIndex")
    DO UPDATE SET "vector" = EXCLUDED."vector", "text" = EXCLUDED."text", "updatedAt" = now()`;
}

export async function embedAndStore(
  deps: AiDeps,
  input: { workspaceId: string; sourceType: string; sourceId: string; text: string },
): Promise<{ chunks: number }> {
  assertAllowed(
    await checkAiAllowed(deps.db, input.workspaceId, 'embedding', deps.settings, {
      now: deps.now(),
    }),
    'embedding',
  );

  const chunks = chunkText(redactPii(input.text, deps.settings.piiRedaction));
  if (!chunks.length) return { chunks: 0 };

  const { vectors, promptTokens } = await deps.model.embed(chunks);
  if (vectors.length !== chunks.length) {
    throw new NexusError('INTERNAL', {
      message: `embedding model returned ${vectors.length} vectors for ${chunks.length} chunks`,
    });
  }

  for (let i = 0; i < chunks.length; i++) {
    const vector = vectors[i] ?? [];
    assertDimensions(vector, i);
    await upsertChunk(deps.db, {
      workspaceId: input.workspaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      model: deps.model.name,
      chunkIndex: i,
      text: chunks[i] ?? '',
      vector,
    });
  }

  // Stale chunks from a previously longer text would otherwise linger and pollute results.
  await deps.db.embedding.deleteMany({
    where: {
      workspaceId: input.workspaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      model: deps.model.name,
      chunkIndex: { gte: chunks.length },
    },
  });

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'embedding',
    model: deps.model.name,
    promptTokens,
    completionTokens: 0,
  });

  return { chunks: chunks.length };
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (!a.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * §13.7 / ADR-017's deferred Tier-3 signal. The primitive only — the nightly identity re-score
 * owns when to call it and what similarity floor clears a `BIO_EMBEDDING` signal.
 */
export async function bioEmbeddingSimilarity(
  model: AiModel,
  bioA: string,
  bioB: string,
): Promise<number | null> {
  const a = bioA.trim();
  const b = bioB.trim();
  if (!a || !b) return null;
  const { vectors } = await model.embed([a, b]);
  return cosineSimilarity(vectors[0] ?? [], vectors[1] ?? []);
}
