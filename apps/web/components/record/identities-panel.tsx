'use client';

/**
 * The person's channel identities (§12.2.B): one row per platform account with its handle,
 * last touch, how it was linked (with the "why" panel), and unlink for those who may.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { Skeleton } from '@/components/skeleton';
import { evidenceOf, WhyPanel } from '@/components/record/why-panel';
import { isoOf } from '@/lib/format';
import { identityLabel, LINK_METHOD_LABEL, platformName, platformShort } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';

export function IdentitiesPanel({
  slug,
  recordId,
  canLink,
}: {
  slug: string;
  recordId: string;
  canLink: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const key = trpc.identity.list.queryKey({ personRecordId: recordId });
  const list = useQuery(trpc.identity.list.queryOptions({ personRecordId: recordId }));
  const [open, setOpen] = useState<string | null>(null);
  const unlink = useMutation(
    trpc.identity.unlink.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: trpc.timeline.list.pathKey() });
      },
    }),
  );

  return (
    <section aria-labelledby="identities-heading" className="flex flex-col gap-3">
      <h2 id="identities-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
        Channel identities{' '}
        {list.data ? (
          <span className="tnum font-normal text-ink-muted">({list.data.length})</span>
        ) : null}
      </h2>
      {list.isPending ? (
        <Skeleton className="h-16" />
      ) : list.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {list.error.message}
        </p>
      ) : list.data.length === 0 ? (
        <EmptyState
          compact
          title="No channel identities yet"
          description="When this person messages, comments or submits a form on a connected platform, their account appears here. Unresolved accounts wait in Duplicates."
          action={
            <Link
              href={`/w/${slug}/duplicates`}
              className="text-[var(--text-sm)] text-link underline-offset-2 hover:underline"
            >
              Open Duplicates
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
          {list.data.map((i) => {
            const ev = evidenceOf(i.link?.evidence);
            const isOpen = open === i.id;
            return (
              <li
                key={i.id}
                className="flex flex-col gap-2 px-3 py-2 text-[var(--text-sm)]"
                data-testid="identity-row"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                  {i.handle && i.displayName ? (
                    <span className="text-ink-muted">@{i.handle}</span>
                  ) : null}
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    last seen <LocalDateTime iso={isoOf(i.lastSeenAt) ?? ''} />
                  </span>
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    {i.events} events · {i.conversations} threads
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {i.link ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : i.id)}
                        className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                      >
                        {LINK_METHOD_LABEL[i.link.method] ?? i.link.method.toLowerCase()} ·{' '}
                        {Math.round(i.link.confidence * 100)}%
                        {i.link.confirmedAt ? ' · confirmed' : ''} — why?
                      </button>
                    ) : null}
                    {canLink ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={unlink.isPending}
                        onClick={() => unlink.mutate({ identityId: i.id })}
                      >
                        Unlink
                      </Button>
                    ) : null}
                  </span>
                </div>
                {isOpen && i.link ? (
                  <WhyPanel
                    score={i.link.confidence}
                    signals={ev.signals}
                    note={
                      ev.note ??
                      (i.link.confirmedBy
                        ? `Confirmed by ${i.link.confirmedBy.name ?? i.link.confirmedBy.email}`
                        : null)
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {unlink.isError ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {unlink.error.message}
        </p>
      ) : null}
    </section>
  );
}
