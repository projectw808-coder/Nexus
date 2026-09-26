/**
 * §13.6 semantic search: embed the query, then let `@nexus/db`'s `hybridSearch` fuse Postgres FTS
 * with pgvector cosine distance (reciprocal rank fusion), scoped to the workspace.
 */
import { hybridSearch, type HybridSearchHit } from '@nexus/db';
import { assertAllowed, checkAiAllowed, recordAiUsage } from './budget.ts';
import type { AiDeps } from './context.ts';

export async function semanticSearch(
  deps: AiDeps,
  input: { workspaceId: string; query: string; limit?: number },
): Promise<HybridSearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  assertAllowed(
    await checkAiAllowed(deps.db, input.workspaceId, 'embedding', deps.settings, {
      now: deps.now(),
    }),
    'embedding',
  );

  const { vectors, promptTokens } = await deps.model.embed([query]);
  const queryVector = vectors[0] ?? [];

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'embedding',
    model: deps.model.name,
    promptTokens,
    completionTokens: 0,
  });

  return hybridSearch(deps.db, {
    workspaceId: input.workspaceId,
    queryText: query,
    queryVector,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}
