/**
 * Stage 4 — resolve (§4.1, §10, ADR-017). Runs after the conversation and timeline sinks have
 * written their rows: every identity this batch touched that has no person yet is scored
 * against the workspace's people. Tier-1 evidence links at once (and backfills the identity's
 * events and conversations onto the person in one batched update), weaker evidence files a
 * `MergeSuggestion`, an anchored identity with no match becomes a new Person, everything else
 * waits for the nightly re-score. Every automatic link is audited.
 */
import type { CanonicalEntity } from '@nexus/connector-sdk';
import {
  resolveIdentity,
  systemActorFor,
  writeAudit,
  type ResolveOutcome,
  type TenantRuntime,
} from '@nexus/db';
import type { CanonicalSink, NormalizedBatch } from '../sink.ts';

export type IdentitySinkStats = {
  scored: number;
  linked: number;
  created: number;
  suggested: number;
  unresolved: number;
};

const PER_BATCH_LIMIT = 500;

/** Platform ids of people who acted in this batch. */
export function actorExternalIds(entities: CanonicalEntity[]): string[] {
  const out = new Set<string>();
  for (const e of entities) {
    switch (e.kind) {
      case 'person':
        out.add(e.externalId);
        break;
      case 'message':
        if (e.direction === 'inbound') out.add(e.authorExternalId);
        break;
      case 'engagement':
        if (e.actorExternalId) out.add(e.actorExternalId);
        break;
      case 'review':
        if (e.authorExternalId) out.add(e.authorExternalId);
        break;
      case 'lead':
        out.add(`lead:${e.externalId}`);
        break;
      case 'conversation':
        for (const p of e.participants) if (p.role !== 'owner') out.add(p.externalId);
        break;
      default:
        break;
    }
  }
  return [...out];
}

export function createIdentitySink(
  runtime: TenantRuntime,
  opts: {
    onResolved?: (r: { workspaceId: string; identityId: string; outcome: ResolveOutcome }) => void;
  } = {},
): CanonicalSink & { stats: IdentitySinkStats } {
  const stats: IdentitySinkStats = {
    scored: 0,
    linked: 0,
    created: 0,
    suggested: 0,
    unresolved: 0,
  };
  return {
    stats,
    async materialize(batch: NormalizedBatch) {
      const externalIds = actorExternalIds(batch.items.flatMap((i) => i.entities)).slice(
        0,
        PER_BATCH_LIMIT,
      );
      if (!externalIds.length) return;
      const actor = systemActorFor(batch.workspaceId, batch.connectionId);
      const pending = await runtime.withTenant(actor, (db) =>
        db.identity.findMany({
          where: {
            platform: batch.platform,
            externalId: { in: externalIds },
            personRecordId: null,
            deletedAt: null,
          },
          select: { id: true },
        }),
      );
      for (const { id } of pending) {
        // One short transaction per identity: a failure on one never rolls back the others.
        const outcome = await runtime.withTenant(actor, async (db) => {
          const r = await resolveIdentity(db, actor, { identityId: id });
          if (r.action === 'linked' || r.action === 'created' || r.action === 'suggested')
            await writeAudit(db, actor, {
              action: `identity.${r.action === 'linked' ? 'auto_linked' : r.action === 'created' ? 'person_created' : 'suggested'}`,
              targetType: 'Identity',
              targetId: id,
              diff:
                r.action === 'created'
                  ? { personRecordId: r.personRecordId }
                  : {
                      personRecordId: r.personRecordId,
                      score: r.score.score,
                      method: r.score.method,
                    },
            });
          return r;
        });
        stats.scored += 1;
        if (outcome.action === 'linked') stats.linked += 1;
        else if (outcome.action === 'created') stats.created += 1;
        else if (outcome.action === 'suggested') stats.suggested += 1;
        else if (outcome.action === 'unresolved') stats.unresolved += 1;
        opts.onResolved?.({ workspaceId: batch.workspaceId, identityId: id, outcome });
      }
    },
  };
}
