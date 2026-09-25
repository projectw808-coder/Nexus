'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { Skeleton } from '@/components/skeleton';
import { TimelinePanel } from '@/components/record/timeline-panel';
import { evidenceOf, WhyPanel } from '@/components/record/why-panel';
import { isoOf } from '@/lib/format';
import { LINK_METHOD_LABEL, platformName } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Identity = RouterOutputs['identity']['get'];

export function IdentityView({
  slug,
  initial,
  canLink,
  canCreate,
}: {
  slug: string;
  initial: Identity;
  canLink: boolean;
  canCreate: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const identity = useQuery({
    ...trpc.identity.get.queryOptions({ id: initial.id }),
    initialData: initial,
  });
  const i = identity.data;
  const candidates = useQuery({
    ...trpc.identity.candidates.queryOptions({ id: i.id }),
    enabled: !i.person,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.identity.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.timeline.list.pathKey() });
    router.refresh();
  };
  const link = useMutation(trpc.identity.link.mutationOptions({ onSuccess: refresh }));
  const unlink = useMutation(trpc.identity.unlink.mutationOptions({ onSuccess: refresh }));
  const create = useMutation(
    trpc.identity.createPerson.mutationOptions({
      onSuccess: (r) => {
        refresh();
        router.push(`/w/${slug}/records/person/${r.personRecordId}`);
      },
    }),
  );
  const resolve = useMutation(trpc.identity.resolve.mutationOptions({ onSuccess: refresh }));
  const [search, setSearch] = useState('');
  const people = useQuery({
    ...trpc.person.query.queryOptions({
      query: { filters: [], sort: [], limit: 8, includeDeleted: false, search },
    }),
    enabled: canLink && !i.person && search.trim().length >= 2,
  });
  const activeLink = i.links.find((l) => !l.revokedAt) ?? null;
  const error = link.error ?? unlink.error ?? create.error ?? resolve.error;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-labelledby="profile-heading" className="flex flex-col gap-3">
          <h2 id="profile-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            On {platformName(i.platform)}
          </h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 rounded-[var(--radius-card)] border border-hairline bg-card px-3 py-2 text-[var(--text-sm)]">
            <dt className="text-ink-secondary">Handle</dt>
            <dd>{i.handle ? `@${i.handle}` : <span className="text-ink-muted">—</span>}</dd>
            <dt className="text-ink-secondary">Display name</dt>
            <dd>{i.displayName ?? <span className="text-ink-muted">—</span>}</dd>
            <dt className="text-ink-secondary">E-mail</dt>
            <dd>{i.email ?? <span className="text-ink-muted">—</span>}</dd>
            <dt className="text-ink-secondary">Phone</dt>
            <dd>{i.phone ?? <span className="text-ink-muted">—</span>}</dd>
            <dt className="text-ink-secondary">Platform id</dt>
            <dd className="font-mono text-[var(--text-xs)]">{i.externalId}</dd>
            <dt className="text-ink-secondary">Profile</dt>
            <dd>
              {i.profileUrl ? (
                <a
                  href={i.profileUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-link underline-offset-2 hover:underline"
                >
                  View on {platformName(i.platform)}
                </a>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </dd>
            <dt className="text-ink-secondary">First seen</dt>
            <dd>
              <LocalDateTime iso={isoOf(i.firstSeenAt) ?? ''} />
            </dd>
            <dt className="text-ink-secondary">Last seen</dt>
            <dd>
              <LocalDateTime iso={isoOf(i.lastSeenAt) ?? ''} />
            </dd>
            <dt className="text-ink-secondary">Activity</dt>
            <dd>
              {i.events} events · {i.conversations} threads
            </dd>
          </dl>
          {i.handleHistory.length > 1 ? (
            <div className="text-[var(--text-xs)] text-ink-secondary">
              <p className="font-medium text-ink">Handle history</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {i.handleHistory.map((h) => (
                  <li key={`${h.handle}:${h.from}`}>
                    @{h.handle} · from <LocalDateTime iso={h.from} />
                    {h.to ? (
                      <>
                        {' '}
                        to <LocalDateTime iso={h.to} />
                      </>
                    ) : (
                      ' (current)'
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="resolution-heading" className="flex flex-col gap-3">
          <h2
            id="resolution-heading"
            className="text-[var(--text-md)] font-semibold tracking-tight"
          >
            Resolution
          </h2>
          {i.person && activeLink ? (
            <div className="flex flex-col gap-2">
              <p className="text-[var(--text-sm)]">
                Linked to{' '}
                <Link
                  href={`/w/${slug}/records/person/${i.person.id}`}
                  className="font-medium text-link underline-offset-2 hover:underline"
                >
                  {i.person.label}
                </Link>{' '}
                <span className="text-ink-muted">
                  ({LINK_METHOD_LABEL[activeLink.method] ?? activeLink.method.toLowerCase()},{' '}
                  {Math.round(activeLink.confidence * 100)}%
                  {activeLink.confirmedBy
                    ? `, confirmed by ${activeLink.confirmedBy.name ?? activeLink.confirmedBy.email}`
                    : ''}
                  )
                </span>
              </p>
              <WhyPanel
                score={activeLink.confidence}
                signals={evidenceOf(activeLink.evidence).signals}
                note={evidenceOf(activeLink.evidence).note}
              />
              {canLink ? (
                <div>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate({ identityId: i.id })}
                  >
                    {unlink.isPending ? 'Unlinking…' : 'Unlink from this person'}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {i.suggestions.some((s) => s.status === 'PENDING') ? (
                <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3 text-[var(--text-sm)]">
                  {i.suggestions
                    .filter((s) => s.status === 'PENDING')
                    .map((s) => (
                      <div key={s.id} className="flex flex-col gap-2">
                        <p>
                          Suggested: this is{' '}
                          <Link
                            href={`/w/${slug}/records/person/${s.person.id}`}
                            className="font-medium text-link underline-offset-2 hover:underline"
                          >
                            {s.person.label}
                          </Link>{' '}
                          <span className="tnum text-ink-muted">
                            ({Math.round(s.score * 100)}%)
                          </span>
                          {' · '}
                          <Link
                            href={`/w/${slug}/duplicates`}
                            className="text-link underline-offset-2 hover:underline"
                          >
                            review in Duplicates
                          </Link>
                        </p>
                        <WhyPanel score={s.score} signals={s.signals.signals} compact />
                      </div>
                    ))}
                </div>
              ) : null}

              {candidates.isPending ? (
                <Skeleton className="h-12" />
              ) : candidates.data && candidates.data.length > 0 ? (
                <ul className="flex flex-col gap-2" aria-label="Possible people">
                  {candidates.data.map((c) => (
                    <li
                      key={c.person.id}
                      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3 text-[var(--text-sm)]"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/w/${slug}/records/person/${c.person.id}`}
                          className="font-medium text-link underline-offset-2 hover:underline"
                        >
                          {c.person.label}
                        </Link>
                        <span className="tnum text-ink-muted">{Math.round(c.score * 100)}%</span>
                        {canLink ? (
                          <Button
                            size="sm"
                            variant="primary"
                            className="ml-auto"
                            disabled={link.isPending}
                            onClick={() =>
                              link.mutate({ identityId: i.id, personRecordId: c.person.id })
                            }
                          >
                            This is them
                          </Button>
                        ) : null}
                      </div>
                      <WhyPanel score={c.score} signals={c.signals} compact />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  title="No likely match"
                  description="Nobody in this workspace shares an e-mail, phone, handle or similar name with this account."
                />
              )}

              {canLink ? (
                <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3">
                  <label htmlFor="link-search" className="text-[var(--text-sm)] font-medium">
                    Link to a person
                  </label>
                  <input
                    id="link-search"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search people by name…"
                    className="w-full max-w-sm rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-[var(--text-sm)] text-ink"
                  />
                  {people.data ? (
                    <ul className="flex flex-wrap gap-1" aria-label="Matching people">
                      {people.data.items.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            disabled={link.isPending}
                            onClick={() => link.mutate({ identityId: i.id, personRecordId: p.id })}
                            className="rounded-[var(--radius-pill)] border border-hairline px-2 py-0.5 text-[var(--text-xs)] hover:border-strong"
                          >
                            {p.label}
                          </button>
                        </li>
                      ))}
                      {people.data.items.length === 0 ? (
                        <li className="text-[var(--text-xs)] text-ink-muted">Nobody matches.</li>
                      ) : null}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {canCreate ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={create.isPending}
                        onClick={() => create.mutate({ identityId: i.id })}
                      >
                        {create.isPending ? 'Creating…' : 'Create a new person from this account'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ identityId: i.id })}
                    >
                      {resolve.isPending ? 'Scoring…' : 'Run the resolver now'}
                    </Button>
                    {resolve.data ? (
                      <span role="status" className="text-[var(--text-xs)] text-ink-secondary">
                        {resolve.data.action === 'unresolved'
                          ? 'Still unresolved — no signal strong enough.'
                          : resolve.data.action === 'suggested'
                            ? 'Filed a suggestion for review.'
                            : resolve.data.action === 'created'
                              ? 'Created a person.'
                              : 'Linked.'}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-[var(--text-xs)] text-ink-muted">
                  Your role can read identities but not link them.
                </p>
              )}
            </div>
          )}
          {error ? (
            <p role="alert" className="text-[var(--text-sm)] text-critical">
              {error.message}
            </p>
          ) : null}
        </section>
      </div>

      <TimelinePanel slug={slug} identityId={i.id} title="This account's timeline" />
    </div>
  );
}
