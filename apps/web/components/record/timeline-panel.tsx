'use client';

/**
 * The unified timeline (§12.2.B): chronological, filter chips per platform and per event type
 * (from the server's facets), collapsible days, each entry showing its source and provenance
 * — the platform, the connection it came through, whether it was attached to the person or
 * to a channel identity, and a "view on platform" link when the platform gives one.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { Skeleton } from '@/components/skeleton';
import { isoOf } from '@/lib/format';
import { identityLabel, platformName, platformShort, TIMELINE_TYPE_LABEL } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Platform = NonNullable<RouterOutputs['timeline']['list']['items'][number]['platform']>;
type TimelineType = RouterOutputs['timeline']['list']['items'][number]['type'];
type Item = RouterOutputs['timeline']['list']['items'][number];

export function TimelinePanel({
  slug,
  recordId,
  identityId,
  title = 'Timeline',
}: {
  slug: string;
  recordId?: string;
  identityId?: string;
  title?: string;
}) {
  const trpc = useTRPC();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [types, setTypes] = useState<TimelineType[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scope = recordId ? { recordId } : { identityId: identityId! };
  const query = useInfiniteQuery({
    ...trpc.timeline.list.infiniteQueryOptions(
      { ...scope, platforms, types, limit: 50 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined },
    ),
    initialPageParam: null as string | null,
  });
  const pages = query.data?.pages ?? [];
  const facets = pages[0]?.facets ?? { platforms: {}, types: {} };
  const items = pages.flatMap((p) => p.items);
  const days = groupByDay(items);
  const toggle = <T extends string>(list: T[], v: T, set: (x: T[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <section
      aria-labelledby="timeline-heading"
      className="flex flex-col gap-3"
      data-testid="timeline"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          {title}{' '}
          {pages[0] ? (
            <span className="tnum font-normal text-ink-muted">
              ({Object.values(facets.types).reduce((a, b) => a + b, 0)})
            </span>
          ) : null}
        </h2>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filters">
          {Object.entries(facets.platforms)
            .filter(([p]) => p !== 'NONE')
            .map(([p, n]) => (
              <FilterChip
                key={p}
                active={platforms.includes(p as Platform)}
                onClick={() => toggle(platforms, p as Platform, setPlatforms)}
                label={`${platformName(p)} ${n}`}
              />
            ))}
          {Object.entries(facets.types).map(([t, n]) => (
            <FilterChip
              key={t}
              active={types.includes(t as TimelineType)}
              onClick={() => toggle(types, t as TimelineType, setTypes)}
              label={`${TIMELINE_TYPE_LABEL[t] ?? t} ${n}`}
            />
          ))}
          {platforms.length || types.length ? (
            <button
              type="button"
              className="px-1 text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
              onClick={() => {
                setPlatforms([]);
                setTypes([]);
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="h-24" />
      ) : query.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {query.error.message}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          title={
            platforms.length || types.length ? 'Nothing matches these filters' : 'No activity yet'
          }
          description={
            platforms.length || types.length
              ? 'Clear a filter to see the rest of the history.'
              : 'Messages, comments, mentions, lead forms, notes and field changes land here as they happen.'
          }
        />
      ) : (
        <ol className="flex flex-col gap-3">
          {days.map(([day, rows]) => {
            const isCollapsed = collapsed.has(day);
            return (
              <li key={day}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(day)) n.delete(day);
                      else n.add(day);
                      return n;
                    })
                  }
                  className="mb-1 flex w-full items-center gap-2 text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted"
                >
                  <span aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
                  {day}
                  <span className="tnum font-normal">({rows.length})</span>
                </button>
                {isCollapsed ? null : (
                  <ol className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
                    {rows.map((e) => (
                      <TimelineEntry key={e.id} item={e} slug={slug} />
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="self-start text-[var(--text-sm)] text-link underline-offset-2 hover:underline"
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      ) : null}
    </section>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[var(--text-xs)] ${
        active
          ? 'border-strong bg-raised text-ink'
          : 'border-hairline text-ink-secondary hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

function TimelineEntry({ item: e, slug }: { item: Item; slug: string }) {
  const iso = isoOf(e.occurredAt) ?? '';
  const actor =
    e.actor?.kind === 'user'
      ? (e.actor.name ?? e.actor.email)
      : e.actor?.kind === 'identity'
        ? identityLabel({
            displayName: e.actor.displayName,
            handle: e.actor.handle,
            externalId: e.actor.id,
          })
        : null;
  return (
    <li
      className="flex flex-col gap-1 px-3 py-2 text-[var(--text-sm)]"
      data-testid="timeline-entry"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-sm bg-raised px-1 font-mono text-[10px] font-semibold uppercase text-ink-secondary">
          {TIMELINE_TYPE_LABEL[e.type] ?? e.type}
        </span>
        {e.platform ? (
          <span
            className="rounded-sm border border-hairline px-1 font-mono text-[10px] font-semibold text-ink-secondary"
            title={platformName(e.platform)}
          >
            {platformShort(e.platform)}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 break-words">{e.summary}</span>
        <time dateTime={iso} className="text-[var(--text-xs)] text-ink-muted">
          <LocalDateTime iso={iso} />
        </time>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--text-xs)] text-ink-muted">
        {actor ? <span>by {actor}</span> : null}
        {e.connection ? <span>via {e.connection.label}</span> : null}
        {e.identity ? (
          <Link
            href={`/w/${slug}/identities/${e.identity.id}`}
            className="text-link underline-offset-2 hover:underline"
          >
            {e.provenance === 'identity' ? 'on identity' : 'identity'}{' '}
            {identityLabel({
              displayName: e.identity.displayName,
              handle: e.identity.handle,
              externalId: e.identity.id,
            })}
          </Link>
        ) : (
          <span>on this record</span>
        )}
        {e.sourceUrl ? (
          <a
            href={e.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-link underline-offset-2 hover:underline"
          >
            View on {platformName(e.platform) || 'platform'}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function groupByDay(items: Item[]): [string, Item[]][] {
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });
  const out = new Map<string, Item[]>();
  for (const i of items) {
    const day = fmt.format(new Date(i.occurredAt));
    const arr = out.get(day);
    if (arr) arr.push(i);
    else out.set(day, [i]);
  }
  return [...out.entries()];
}
