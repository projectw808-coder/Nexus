/**
 * The nightly re-score (§10): as new signals arrive, open suggestions are re-scored and may be
 * promoted to an automatic link or merge; unresolved identities not scored in the last day get
 * another pass; people touched in the last day are scanned for duplicates. Cross-tenant, one
 * workspace at a time, every write inside that workspace's own tenant transaction and audited
 * as SYSTEM.
 */
import {
  listWorkspaceIds,
  personAttributes,
  rescoreSuggestion,
  resolveIdentity,
  scanPersonForDuplicates,
  systemActorFor,
  writeAudit,
} from '@nexus/db';
import type { SyncDeps } from './deps.ts';

export type RescoreResult = {
  workspaces: number;
  identities: { scored: number; linked: number; created: number; suggested: number };
  suggestions: { rescored: number; promoted: number; expired: number };
  duplicates: { scanned: number; suggested: number; merged: number };
};

const DAY_MS = 24 * 60 * 60_000;

export async function runIdentityRescore(
  deps: SyncDeps,
  opts: { now?: Date; workspaceId?: string; limit?: number } = {},
): Promise<RescoreResult> {
  const now = opts.now ?? deps.now?.() ?? new Date();
  const limit = opts.limit ?? 2_000;
  const result: RescoreResult = {
    workspaces: 0,
    identities: { scored: 0, linked: 0, created: 0, suggested: 0 },
    suggestions: { rescored: 0, promoted: 0, expired: 0 },
    duplicates: { scanned: 0, suggested: 0, merged: 0 },
  };
  const workspaceIds = opts.workspaceId ? [opts.workspaceId] : await listWorkspaceIds(deps.runtime);
  for (const workspaceId of workspaceIds) {
    result.workspaces += 1;
    const actor = systemActorFor(workspaceId);

    // 1. Open suggestions first, so new evidence promotes a waiting suggestion rather than expiring it.
    const pending = await deps.runtime.withTenant(actor, (db) =>
      db.mergeSuggestion.findMany({
        where: { status: 'PENDING', deletedAt: null },
        orderBy: { score: 'desc' },
        select: { id: true },
        take: limit,
      }),
    );
    for (const { id } of pending) {
      const r = await deps.runtime.withTenant(actor, async (db) => {
        const o = await rescoreSuggestion(db, actor, id);
        if (o.promoted)
          await writeAudit(db, actor, {
            action: 'merge_suggestion.auto_merged',
            targetType: 'MergeSuggestion',
            targetId: id,
            diff: { score: o.score, via: 'nightly' },
          });
        return o;
      });
      result.suggestions.rescored += 1;
      if (r.promoted) result.suggestions.promoted += 1;
      else if (r.status === 'EXPIRED') result.suggestions.expired += 1;
    }

    // 2. Unresolved identities, oldest attempt first.
    const identities = await deps.runtime.withTenant(actor, (db) =>
      db.identity.findMany({
        where: {
          personRecordId: null,
          deletedAt: null,
          OR: [
            { resolutionAttemptedAt: null },
            { resolutionAttemptedAt: { lt: new Date(now.getTime() - DAY_MS) } },
          ],
        },
        orderBy: [
          { resolutionAttemptedAt: { sort: 'asc', nulls: 'first' } },
          { lastSeenAt: 'desc' },
        ],
        select: { id: true },
        take: limit,
      }),
    );
    for (const { id } of identities) {
      const r = await deps.runtime.withTenant(actor, async (db) => {
        const o = await resolveIdentity(db, actor, { identityId: id, now });
        if (o.action === 'linked' || o.action === 'created' || o.action === 'suggested')
          await writeAudit(db, actor, {
            action: `identity.${o.action === 'linked' ? 'auto_linked' : o.action === 'created' ? 'person_created' : 'suggested'}`,
            targetType: 'Identity',
            targetId: id,
            diff: { personRecordId: o.personRecordId, via: 'nightly' },
          });
        return o;
      });
      result.identities.scored += 1;
      if (r.action === 'linked') result.identities.linked += 1;
      else if (r.action === 'created') result.identities.created += 1;
      else if (r.action === 'suggested') result.identities.suggested += 1;
    }

    // 3. People touched in the last day.
    const people = await deps.runtime.withTenant(actor, async (db) => {
      const pa = await personAttributes(db);
      return db.record.findMany({
        where: {
          objectTypeId: pa.objectTypeId,
          mergeState: 'ACTIVE',
          deletedAt: null,
          updatedAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
        select: { id: true },
        take: limit,
      });
    });
    for (const { id } of people) {
      const r = await deps.runtime.withTenant(actor, async (db) => {
        const o = await scanPersonForDuplicates(db, actor, id);
        if (o.merged)
          await writeAudit(db, actor, {
            action: 'record.auto_merged',
            targetType: 'Record',
            targetId: id,
            diff: { via: 'nightly' },
          });
        return o;
      });
      result.duplicates.scanned += 1;
      result.duplicates.suggested += r.suggested;
      result.duplicates.merged += r.merged;
    }
  }
  deps.logger.info('identity re-score finished', result);
  return result;
}
