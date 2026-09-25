'use client';

/**
 * Merge history and the merge action on a record (§10, ADR-002). Merges are reversible
 * forever: every past merge lists what moved and can be undone from here; a new merge picks
 * another record of the same object by name and asks which one survives.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { LocalDateTime } from '@/components/local-time';
import { isoOf } from '@/lib/format';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Merge = RouterOutputs['record']['get']['merges'][number];

export function MergePanel({
  slug,
  objectSlug,
  recordId,
  recordLabel,
  merges,
  canMerge,
  isMergedAway,
}: {
  slug: string;
  objectSlug: string;
  recordId: string;
  recordLabel: string;
  merges: Merge[];
  canMerge: boolean;
  isMergedAway: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const refreshRelated = () => {
    void qc.invalidateQueries({ queryKey: trpc.timeline.list.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.identity.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.record.pathKey() });
  };
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<{ id: string; label: string } | null>(null);
  const [keepOther, setKeepOther] = useState(false);
  const [confirmUnmerge, setConfirmUnmerge] = useState<string | null>(null);
  const candidates = useQuery({
    ...trpc.record.query.queryOptions({
      objectType: objectSlug,
      query: { filters: [], sort: [], limit: 8, includeDeleted: false, search },
    }),
    enabled: canMerge && search.trim().length >= 2,
  });
  const merge = useMutation(
    trpc.record.merge.mutationOptions({
      onSuccess: (r) => {
        setPick(null);
        setSearch('');
        refreshRelated();
        router.push(`/w/${slug}/records/${objectSlug}/${r.winnerId}`);
        router.refresh();
      },
    }),
  );
  const unmerge = useMutation(
    trpc.record.unmerge.mutationOptions({
      onSuccess: () => {
        setConfirmUnmerge(null);
        refreshRelated();
        router.refresh();
      },
    }),
  );
  const active = merges.filter((m) => !m.unmergedAt);
  const undone = merges.filter((m) => m.unmergedAt);

  return (
    <section
      aria-labelledby="merges-heading"
      className="flex flex-col gap-3"
      data-testid="merge-panel"
    >
      <h2 id="merges-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
        Merges <span className="tnum font-normal text-ink-muted">({merges.length})</span>
      </h2>

      {merges.length === 0 ? (
        <p className="text-[var(--text-sm)] text-ink-secondary">
          This record has never been merged. Merges are reversible: the other record is kept and
          every moved row is remembered.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
          {[...active, ...undone].map((m) => {
            const iAmWinner = m.winner.id === recordId;
            const other = iAmWinner ? m.loser : m.winner;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[var(--text-sm)]"
              >
                <span className="min-w-0 flex-1">
                  {m.unmergedAt ? 'Unmerged from ' : iAmWinner ? 'Absorbed ' : 'Merged into '}
                  <Link
                    href={`/w/${slug}/records/${objectSlug}/${other.id}`}
                    className="font-medium text-link underline-offset-2 hover:underline"
                  >
                    {other.label}
                  </Link>{' '}
                  <span className="text-ink-muted">
                    on <LocalDateTime iso={isoOf(m.mergedAt) ?? ''} />
                    {m.mergedBy
                      ? ` by ${m.mergedBy.name ?? m.mergedBy.email}`
                      : ' automatically'} · {m.moved.fields} field{m.moved.fields === 1 ? '' : 's'},{' '}
                    {m.moved.identities} identit{m.moved.identities === 1 ? 'y' : 'ies'},{' '}
                    {m.moved.timelineEvents} events
                    {m.unmergedAt ? (
                      <>
                        {' '}
                        · undone <LocalDateTime iso={isoOf(m.unmergedAt) ?? ''} />
                        {m.unmergedBy ? ` by ${m.unmergedBy.name ?? m.unmergedBy.email}` : ''}
                      </>
                    ) : null}
                  </span>
                </span>
                {!m.unmergedAt && canMerge ? (
                  confirmUnmerge === m.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-[var(--text-xs)] text-ink-secondary">
                        Restore both records exactly as they were?
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={unmerge.isPending}
                        onClick={() => unmerge.mutate({ mergeId: m.id })}
                      >
                        {unmerge.isPending ? 'Undoing…' : 'Undo merge'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmUnmerge(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setConfirmUnmerge(m.id)}>
                      Unmerge
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {unmerge.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {unmerge.error.message}
        </p>
      ) : null}

      {canMerge && !isMergedAway ? (
        <form
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pick) return;
            merge.mutate(
              keepOther
                ? { winnerId: pick.id, loserId: recordId }
                : { winnerId: recordId, loserId: pick.id },
            );
          }}
        >
          <label htmlFor="merge-search" className="text-[var(--text-sm)] font-medium">
            Merge with another record
          </label>
          <input
            id="merge-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPick(null);
            }}
            placeholder="Search by name…"
            className="w-full max-w-sm rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-[var(--text-sm)] text-ink"
          />
          {candidates.data ? (
            <ul className="flex flex-wrap gap-1" aria-label="Matching records">
              {candidates.data.items
                .filter((r) => r.id !== recordId)
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-pressed={pick?.id === r.id}
                      onClick={() => setPick({ id: r.id, label: r.label })}
                      className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[var(--text-xs)] ${pick?.id === r.id ? 'border-strong bg-raised' : 'border-hairline hover:border-strong'}`}
                    >
                      {r.label}
                    </button>
                  </li>
                ))}
              {candidates.data.items.filter((r) => r.id !== recordId).length === 0 ? (
                <li className="text-[var(--text-xs)] text-ink-muted">No other record matches.</li>
              ) : null}
            </ul>
          ) : null}
          {pick ? (
            <div className="flex flex-wrap items-center gap-3 text-[var(--text-sm)]">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={keepOther}
                  onChange={(e) => setKeepOther(e.target.checked)}
                />
                Keep <strong>{pick.label}</strong> and fold <strong>{recordLabel}</strong> into it
              </label>
              <Button type="submit" variant="primary" size="sm" disabled={merge.isPending}>
                {merge.isPending
                  ? 'Merging…'
                  : keepOther
                    ? `Merge into ${pick.label}`
                    : `Merge ${pick.label} into this record`}
              </Button>
            </div>
          ) : null}
          {merge.isError ? (
            <p role="alert" className="text-[var(--text-xs)] text-critical">
              {merge.error.message}
            </p>
          ) : null}
          <p className="text-[var(--text-xs)] text-ink-muted">
            Values the survivor lacks are taken from the other record; where both have one, the more
            recently updated value wins and the other is kept in the field&apos;s history.
          </p>
        </form>
      ) : null}
    </section>
  );
}
