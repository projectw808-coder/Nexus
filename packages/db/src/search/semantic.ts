/**
 * Phase 10 (spec §13.6): hybrid semantic search — Postgres full-text over `Record.searchVector`
 * fused with pgvector cosine distance over the `Embedding` chunk table, by reciprocal rank
 * fusion. Raw SQL and schema-adjacent, so it lives here rather than in `@nexus/ai`, which calls
 * it with an already-embedded query vector.
 *
 * Coverage: the FTS branch searches `Record` only. `Record.searchVector` is maintained by the
 * `record_search_sync` trigger over every string leaf of `values`, which is the one table with a
 * ready tsvector; messages and notes reach the results through their `Embedding` rows instead.
 *
 * RRF: `score = Σ 1 / (60 + rank)` over whichever of the two ranked lists a row appears in. Both
 * branches filter on `workspaceId` explicitly — defence in depth alongside RLS.
 */
import { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';

export type HybridSearchHit = {
  sourceType: string;
  sourceId: string;
  score: number;
  snippet: string;
};

/** How deep each branch ranks before fusion. */
const BRANCH_LIMIT = 50;
const RRF_K = 60;
const SNIPPET_CHARS = 300;

/** pgvector's text input format. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

export async function hybridSearch(
  db: TenantDb,
  input: { workspaceId: string; queryText: string; queryVector: number[]; limit?: number },
): Promise<HybridSearchHit[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const text = input.queryText.trim();
  const hasText = text.length > 0;
  const hasVector = input.queryVector.length > 0;
  if (!hasText && !hasVector) return [];

  const branches: Prisma.Sql[] = [];

  // Each branch is parenthesised: a UNION branch may only carry its own ORDER BY / LIMIT inside
  // parentheses.
  if (hasText) {
    branches.push(Prisma.sql`(
      SELECT 'record'::text AS "sourceType",
             r."id" AS "sourceId",
             row_number() OVER (
               ORDER BY ts_rank(r."searchVector", websearch_to_tsquery('simple', ${text})) DESC, r."id"
             ) AS "rank",
             left(nexus_jsonb_text(r."values"), ${SNIPPET_CHARS}) AS "snippet"
      FROM "Record" r
      WHERE r."workspaceId" = ${input.workspaceId}
        AND r."deletedAt" IS NULL
        AND r."mergeState" = 'ACTIVE'
        AND r."searchVector" @@ websearch_to_tsquery('simple', ${text})
      ORDER BY ts_rank(r."searchVector", websearch_to_tsquery('simple', ${text})) DESC, r."id"
      LIMIT ${BRANCH_LIMIT})`);
  }

  if (hasVector) {
    const vec = toVectorLiteral(input.queryVector);
    branches.push(Prisma.sql`(
      SELECT e."sourceType",
             e."sourceId",
             row_number() OVER (ORDER BY e."vector" <=> ${vec}::vector, e."id") AS "rank",
             left(e."text", ${SNIPPET_CHARS}) AS "snippet"
      FROM "Embedding" e
      WHERE e."workspaceId" = ${input.workspaceId}
      ORDER BY e."vector" <=> ${vec}::vector, e."id"
      LIMIT ${BRANCH_LIMIT})`);
  }

  const rows = await db.$queryRaw<
    { sourceType: string; sourceId: string; score: number; snippet: string | null }[]
  >(
    Prisma.sql`
      WITH ranked AS (
        ${Prisma.join(branches, ' UNION ALL ')}
      )
      SELECT "sourceType",
             "sourceId",
             SUM(1.0 / (${RRF_K} + "rank"))::float8 AS "score",
             (array_agg("snippet" ORDER BY "rank"))[1] AS "snippet"
      FROM ranked
      GROUP BY "sourceType", "sourceId"
      ORDER BY "score" DESC, "sourceId"
      LIMIT ${limit}`,
  );

  return rows.map((r) => ({
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    score: Number(r.score),
    snippet: r.snippet ?? '',
  }));
}
