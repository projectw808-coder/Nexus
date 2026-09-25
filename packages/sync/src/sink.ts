/**
 * Stages 4–7 of the pipeline (§4.1) hang off this seam: after normalisation, canonical entities
 * are handed to the sink for identity resolution, materialisation, automation and
 * notification. Phase 4 ships the counting sink so the acquire → persist → normalize path is
 * complete and measurable; Phase 6 replaces it with identity resolution and the timeline
 * (ADR-013). The sink must be idempotent per `(objectId, entity)` because replays call it again.
 */
import type { CanonicalEntity, Platform } from '@nexus/connector-sdk';

export type NormalizedBatch = {
  workspaceId: string;
  connectionId: string;
  platform: Platform;
  items: { objectId: string; kind: string; externalId: string; entities: CanonicalEntity[] }[];
};

export interface CanonicalSink {
  materialize(batch: NormalizedBatch): Promise<void>;
}

export function countingSink() {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  let batches = 0;
  return {
    counts,
    get batches() {
      return batches;
    },
    get distinctEntities() {
      return seen.size;
    },
    async materialize(batch: NormalizedBatch) {
      batches += 1;
      for (const item of batch.items) {
        for (const e of item.entities) {
          counts[e.kind] = (counts[e.kind] ?? 0) + 1;
          seen.add(`${batch.connectionId}:${e.kind}:${e.externalId}`);
        }
      }
    },
  } satisfies CanonicalSink & Record<string, unknown>;
}
