'use client';

/**
 * The context sidebar (§12.2.A), backed by Phase 6: the resolved Person (or the unresolved
 * identity with a way to resolve it), channel identity chips, open deals, the last five
 * timeline events, and quick actions — create deal, add to list, assign, snooze, tag.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/button';
import { IdentityChips } from '@/components/record/identity-chips';
import { LocalDateTime } from '@/components/local-time';
import { isoOf } from '@/lib/format';
import { identityLabel, platformName, TIMELINE_TYPE_LABEL } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import { memberName, snoozePresets, type Member } from './inbox-shared';

type RelationshipBriefContent = {
  kind: 'relationship_brief';
  summary: string;
  caresAbout: string[];
  openThreads: string[];
  riskFlags: string[];
};

export function ContextSidebar({
  slug,
  conversationId,
  members,
  canTriage,
  canWriteRecords,
  selfId,
}: {
  slug: string;
  conversationId: string;
  members: Member[];
  canTriage: boolean;
  canWriteRecords: boolean;
  selfId: string;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ctx = useQuery(trpc.conversation.context.queryOptions({ id: conversationId }));
  const lists = useQuery({ ...trpc.list.list.queryOptions(), enabled: canWriteRecords });
  const personId = ctx.data?.person?.id;
  const insights = useQuery({
    ...trpc.ai.insights.list.queryOptions({ recordId: personId ?? '' }),
    enabled: !!personId,
  });
  const leadScore = useQuery({
    ...trpc.ai.scoreLead.queryOptions({ recordId: personId ?? '' }),
    enabled: !!personId,
  });
  const generateBrief = useMutation(
    trpc.ai.generateRelationshipBrief.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.ai.pathKey() }),
    }),
  );
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.conversation.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.identity.pathKey() });
  };
  const assign = useMutation(trpc.conversation.assign.mutationOptions({ onSuccess: invalidate }));
  const snooze = useMutation(trpc.conversation.snooze.mutationOptions({ onSuccess: invalidate }));
  const setTags = useMutation(trpc.conversation.setTags.mutationOptions({ onSuccess: invalidate }));
  const createPerson = useMutation(
    trpc.identity.createPerson.mutationOptions({ onSuccess: invalidate }),
  );
  const createDeal = useMutation(trpc.deal.create.mutationOptions({ onSuccess: invalidate }));
  const addToList = useMutation(trpc.listEntry.add.mutationOptions({ onSuccess: invalidate }));
  const [dealName, setDealName] = useState('');
  const [tag, setTag] = useState('');
  const [action, setAction] = useState<'deal' | 'list' | 'tag' | null>(null);
  const thread = qc.getQueryData(trpc.conversation.get.queryKey({ id: conversationId }));

  if (ctx.isPending) return <p className="text-[var(--text-sm)] text-ink-muted">Loading…</p>;
  if (ctx.isError)
    return (
      <p role="alert" className="text-[var(--text-sm)] text-critical">
        {ctx.error.message}
      </p>
    );
  const c = ctx.data;
  const identity = c.identities[0] ?? null;
  const error =
    assign.error ??
    snooze.error ??
    setTags.error ??
    createPerson.error ??
    createDeal.error ??
    addToList.error;

  return (
    <aside
      aria-label="Context"
      className="flex flex-col gap-4 text-[var(--text-sm)]"
      data-testid="context-sidebar"
    >
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
          Person
        </h3>
        {c.person ? (
          <Link
            href={`/w/${slug}/records/person/${c.person.id}`}
            className="text-[var(--text-md)] font-semibold text-link underline-offset-2 hover:underline"
            data-testid="context-person"
          >
            {c.person.label}
          </Link>
        ) : identity ? (
          <div className="flex flex-col gap-1">
            <p className="font-medium">{identityLabel(identity)}</p>
            <p className="text-[var(--text-xs)] text-ink-muted">
              {platformName(identity.platform)} account, not linked to a person yet.{' '}
              <Link
                href={`/w/${slug}/identities/${identity.id}`}
                className="text-link underline-offset-2 hover:underline"
              >
                Resolve
              </Link>
            </p>
            {canWriteRecords ? (
              <Button
                size="sm"
                onClick={() => createPerson.mutate({ identityId: identity.id })}
                disabled={createPerson.isPending}
                data-testid="create-person"
              >
                {createPerson.isPending ? 'Creating…' : 'Create a person from this account'}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-ink-muted">No identity on this thread.</p>
        )}
        {c.identities.length ? <IdentityChips slug={slug} identities={c.identities} /> : null}
        {c.openThreads ? (
          <p className="text-[var(--text-xs)] text-ink-muted">
            {c.openThreads} other open thread{c.openThreads === 1 ? '' : 's'}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
          Open deals
        </h3>
        {c.deals.length === 0 ? (
          <p className="text-[var(--text-xs)] text-ink-muted">
            {c.person ? 'No deals yet.' : 'Deals attach once the person is resolved.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {c.deals.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <Link
                  href={`/w/${slug}/records/deal/${d.id}`}
                  className="truncate text-link underline-offset-2 hover:underline"
                >
                  {d.label}
                </Link>
                <span className="shrink-0 text-[var(--text-xs)] text-ink-muted">
                  {d.stage ?? ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
          Recent activity
        </h3>
        {c.recent.length === 0 ? (
          <p className="text-[var(--text-xs)] text-ink-muted">Nothing yet.</p>
        ) : (
          <ol className="flex flex-col gap-1" data-testid="context-recent">
            {c.recent.map((e) => (
              <li key={e.id} className="flex flex-col text-[var(--text-xs)]">
                <span className="truncate">
                  <span className="mr-1 rounded-sm bg-raised px-1 font-mono text-[10px] uppercase text-ink-secondary">
                    {TIMELINE_TYPE_LABEL[e.type] ?? e.type}
                  </span>
                  {e.summary}
                </span>
                <span className="text-ink-muted">
                  <LocalDateTime iso={isoOf(e.occurredAt) ?? ''} />
                </span>
              </li>
            ))}
          </ol>
        )}
        {c.person ? (
          <Link
            href={`/w/${slug}/records/person/${c.person.id}#timeline-heading`}
            className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
          >
            Full timeline
          </Link>
        ) : identity ? (
          <Link
            href={`/w/${slug}/identities/${identity.id}`}
            className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
          >
            Full timeline
          </Link>
        ) : null}
      </section>

      {c.person ? (
        <section className="flex flex-col gap-1.5" aria-label="AI relationship brief">
          <div className="flex items-center justify-between">
            <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
              AI relationship brief
            </h3>
            {canWriteRecords ? (
              <button
                type="button"
                onClick={() => generateBrief.mutate({ recordId: c.person!.id })}
                disabled={generateBrief.isPending}
                className="text-[var(--text-xs)] text-link underline-offset-2 hover:underline disabled:opacity-50"
              >
                {generateBrief.isPending
                  ? 'Generating…'
                  : insights.data?.length
                    ? 'Regenerate'
                    : 'Generate'}
              </button>
            ) : null}
          </div>
          {(() => {
            const brief = insights.data?.find(
              (i) => (i.content as { kind?: string } | null)?.kind === 'relationship_brief',
            );
            if (generateBrief.error)
              return (
                <p role="alert" className="text-[var(--text-xs)] text-critical">
                  {generateBrief.error.message}
                </p>
              );
            if (!brief)
              return (
                <p className="text-[var(--text-xs)] text-ink-muted">
                  No brief yet — generate one from this person&apos;s history across every channel.
                </p>
              );
            const content = brief.content as RelationshipBriefContent;
            return (
              <div className="flex flex-col gap-1.5 text-[var(--text-xs)]">
                <p>{content.summary}</p>
                {content.caresAbout.length ? (
                  <p className="text-ink-secondary">Cares about: {content.caresAbout.join(', ')}</p>
                ) : null}
                {content.openThreads.length ? (
                  <p className="text-ink-secondary">
                    Open threads: {content.openThreads.join('; ')}
                  </p>
                ) : null}
                {content.riskFlags.length ? (
                  <p className="text-critical">Risk: {content.riskFlags.join('; ')}</p>
                ) : null}
                <p className="text-ink-muted">
                  {Array.isArray(brief.citations) ? brief.citations.length : 0} citation
                  {Array.isArray(brief.citations) && brief.citations.length === 1 ? '' : 's'} from
                  the timeline.
                </p>
              </div>
            );
          })()}
          {leadScore.data ? (
            <div className="flex flex-col gap-1 border-t border-hairline pt-1.5 text-[var(--text-xs)]">
              <p className="font-medium">
                Lead score: <span className="tnum">{leadScore.data.score}</span>/100
              </p>
              <ul className="flex flex-col gap-0.5 text-ink-secondary">
                {leadScore.data.factors.map((f) => (
                  <li key={f.label} className="flex justify-between gap-2">
                    <span>{f.label}</span>
                    <span className="tnum shrink-0">
                      {f.contribution >= 0 ? '+' : ''}
                      {f.contribution}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {canTriage ? (
        <section className="flex flex-col gap-1.5" aria-label="Quick actions">
          <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-ink-muted">
            Quick actions
          </h3>
          <div className="flex flex-wrap gap-1">
            {canWriteRecords && c.person ? (
              <Button
                size="sm"
                onClick={() => setAction(action === 'deal' ? null : 'deal')}
                aria-expanded={action === 'deal'}
              >
                Create deal
              </Button>
            ) : null}
            {canWriteRecords && c.person ? (
              <Button
                size="sm"
                onClick={() => setAction(action === 'list' ? null : 'list')}
                aria-expanded={action === 'list'}
              >
                Add to list
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => assign.mutate({ id: conversationId, userId: selfId })}
              disabled={assign.isPending}
            >
              Assign to me
            </Button>
            <select
              aria-label="Snooze"
              className="h-7 rounded-[var(--radius-control)] border border-hairline bg-card px-1.5 text-[var(--text-xs)] text-ink"
              defaultValue=""
              onChange={(e) => {
                const p = snoozePresets().find((x) => x.label === e.target.value);
                if (p) snooze.mutate({ id: conversationId, until: p.until });
                e.target.value = '';
              }}
            >
              <option value="">Snooze…</option>
              {snoozePresets().map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={() => setAction(action === 'tag' ? null : 'tag')}
              aria-expanded={action === 'tag'}
            >
              Tag
            </Button>
          </div>
          {action === 'deal' && c.person ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!dealName.trim()) return;
                createDeal.mutate({ values: { name: dealName.trim(), person: [c.person!.id] } });
                setDealName('');
                setAction(null);
              }}
            >
              <input
                aria-label="Deal name"
                value={dealName}
                onChange={(e) => setDealName(e.target.value)}
                placeholder="Deal name"
                className="h-7 min-w-0 flex-1 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-xs)] text-ink"
              />
              <Button type="submit" size="sm" variant="primary" disabled={createDeal.isPending}>
                Create
              </Button>
            </form>
          ) : null}
          {action === 'list' && c.person ? (
            <select
              aria-label="Add to list"
              className="h-7 rounded-[var(--radius-control)] border border-hairline bg-raised px-1.5 text-[var(--text-xs)] text-ink"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value)
                  addToList.mutate({ listId: e.target.value, recordId: c.person!.id });
                setAction(null);
              }}
            >
              <option value="">Choose a list…</option>
              {(lists.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          ) : null}
          {action === 'tag' ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const v = tag.trim().toLowerCase();
                if (!v) return;
                const current = thread?.tags ?? [];
                setTags.mutate({ id: conversationId, tags: [...new Set([...current, v])] });
                setTag('');
                setAction(null);
              }}
            >
              <input
                aria-label="Tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="tag"
                className="h-7 min-w-0 flex-1 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-[var(--text-xs)] text-ink"
              />
              <Button type="submit" size="sm" variant="primary" disabled={setTags.isPending}>
                Add
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="text-[var(--text-xs)] text-critical">
              {error.message}
            </p>
          ) : null}
          <p className="text-[var(--text-xs)] text-ink-muted">
            Assignee: {memberName(thread?.assignee ?? null)}. Members: {members.length}.
          </p>
        </section>
      ) : null}
    </aside>
  );
}
