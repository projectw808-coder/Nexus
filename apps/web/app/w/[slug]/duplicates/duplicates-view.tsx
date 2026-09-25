'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { WhyPanel } from '@/components/record/why-panel';
import { isoOf } from '@/lib/format';
import { identityLabel, platformName, platformShort } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Queue = RouterOutputs['mergeSuggestion']['list'];
type Unresolved = RouterOutputs['identity']['list'];

export function DuplicatesView({
  slug,
  initialQueue,
  initialUnresolved,
  canReview,
  canLink,
}: {
  slug: string;
  initialQueue: Queue;
  initialUnresolved: Unresolved;
  canReview: boolean;
  canLink: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const queue = useQuery({
    ...trpc.mergeSuggestion.list.queryOptions({ status: 'PENDING', limit: 50 }),
    initialData: initialQueue,
  });
  const unresolved = useQuery({
    ...trpc.identity.list.queryOptions({ unresolved: true, limit: 100 }),
    initialData: initialUnresolved,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.mergeSuggestion.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.identity.pathKey() });
    router.refresh();
  };
  const accept = useMutation(
    trpc.mergeSuggestion.accept.mutationOptions({ onSuccess: invalidate }),
  );
  const reject = useMutation(
    trpc.mergeSuggestion.reject.mutationOptions({ onSuccess: invalidate }),
  );
  const [rawCursor, setCursor] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const items = queue.data.items;
  // Clamp rather than sync state: the list shrinks as suggestions are decided.
  const cursor = Math.min(rawCursor, Math.max(0, items.length - 1));
  const current = items[cursor] ?? null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      setOpen((o) => (o === current.id ? null : current.id));
    } else if (e.key === 'a' && current && canReview) {
      e.preventDefault();
      accept.mutate({ id: current.id });
    } else if (e.key === 'r' && current && canReview) {
      e.preventDefault();
      reject.mutate({ id: current.id });
    }
  };
  const busy = accept.isPending || reject.isPending;
  const error = accept.error ?? reject.error;

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="queue-heading" className="flex flex-col gap-3">
        <h2 id="queue-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Suggested merges{' '}
          <span className="tnum font-normal text-ink-muted">({queue.data.pending})</span>
        </h2>
        {!canReview ? (
          <p className="text-[var(--text-xs)] text-ink-muted">
            Your role can read the queue; managers, admins and owners decide.
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            description="Every identity with strong evidence was linked automatically, and nothing weaker is waiting. The resolver re-scores open questions nightly."
          />
        ) : (
          <ul
            role="listbox"
            aria-label="Merge suggestions"
            aria-activedescendant={current ? `sg-${current.id}` : undefined}
            tabIndex={0}
            onKeyDown={onKey}
            className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            {items.map((s, idx) => {
              const selected = idx === cursor;
              const isOpen = open === s.id;
              const leftLabel = s.identity
                ? `${platformName(s.identity.platform)} ${identityLabel(s.identity)}`
                : (s.left?.label ?? '(record)');
              return (
                <li
                  key={s.id}
                  id={`sg-${s.id}`}
                  role="option"
                  aria-selected={selected}
                  data-testid="suggestion"
                  className={`flex flex-col gap-2 px-3 py-2 text-[var(--text-sm)] ${selected ? 'bg-raised' : ''}`}
                  onClick={() => setCursor(idx)}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="rounded-sm border border-hairline px-1 font-mono text-[10px] font-semibold uppercase text-ink-secondary">
                      {s.kind === 'identity' ? platformShort(s.identity!.platform) : 'rec'}
                    </span>
                    <span className="min-w-0 flex-1">
                      {s.identity ? (
                        <Link
                          href={`/w/${slug}/identities/${s.identity.id}`}
                          className="font-medium text-link underline-offset-2 hover:underline"
                        >
                          {leftLabel}
                        </Link>
                      ) : (
                        <Link
                          href={`/w/${slug}/records/person/${s.left!.id}`}
                          className="font-medium text-link underline-offset-2 hover:underline"
                        >
                          {leftLabel}
                        </Link>
                      )}{' '}
                      <span className="text-ink-muted">is probably</span>{' '}
                      <Link
                        href={`/w/${slug}/records/person/${s.right.id}`}
                        className="font-medium text-link underline-offset-2 hover:underline"
                      >
                        {s.right.label}
                      </Link>
                    </span>
                    <span className="tnum text-ink-muted">{Math.round(s.score * 100)}%</span>
                    <span className="text-[var(--text-xs)] text-ink-muted">
                      <LocalDateTime iso={isoOf(s.createdAt) ?? ''} />
                    </span>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(isOpen ? null : s.id);
                      }}
                      className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                    >
                      why?
                    </button>
                    {canReview ? (
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            accept.mutate({ id: s.id });
                          }}
                        >
                          {s.kind === 'identity' ? 'Link' : 'Merge'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            reject.mutate({ id: s.id });
                          }}
                        >
                          Not the same
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  {isOpen ? <WhyPanel score={s.score} signals={s.signals.signals} /> : null}
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-[var(--text-sm)] text-critical">
            {error.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="unresolved-heading" className="flex flex-col gap-3">
        <h2 id="unresolved-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Unresolved accounts{' '}
          <span className="tnum font-normal text-ink-muted">({unresolved.data.length})</span>
        </h2>
        {unresolved.data.length === 0 ? (
          <EmptyState
            compact
            title="Every account belongs to a person"
            description="Accounts that message or comment without an e-mail, phone or matching handle wait here until they are linked."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {unresolved.data.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[var(--text-sm)]"
                data-testid="unresolved-identity"
              >
                <span
                  className="rounded-sm bg-raised px-1 font-mono text-[10px] font-semibold text-ink-secondary"
                  title={platformName(i.platform)}
                >
                  {platformShort(i.platform)}
                </span>
                <Link
                  href={`/w/${slug}/identities/${i.id}`}
                  className="font-medium text-link underline-offset-2 hover:underline"
                >
                  {identityLabel(i)}
                </Link>
                <span className="text-[var(--text-xs)] text-ink-muted">
                  {i.events} events · {i.conversations} threads · last seen{' '}
                  <LocalDateTime iso={isoOf(i.lastSeenAt) ?? ''} />
                </span>
                {i.suggestion ? (
                  <span className="text-[var(--text-xs)] text-ink-secondary">
                    maybe {i.suggestion.person.label} ({Math.round(i.suggestion.score * 100)}%)
                  </span>
                ) : null}
                {canLink ? (
                  <Link
                    href={`/w/${slug}/identities/${i.id}`}
                    className="ml-auto text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                  >
                    Resolve
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
