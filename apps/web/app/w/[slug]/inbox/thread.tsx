'use client';

/**
 * The thread pane (§12.2.A): platform-native rendering with the parent object of a comment
 * thread, every message stamped with its platform, exact timestamp on hover and a "view on
 * platform" link, internal notes interleaved, and the header actions (assign, snooze, tags,
 * close/reopen/spam) the keyboard model drives.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/button';
import { LocalDateTime } from '@/components/local-time';
import { isoOf } from '@/lib/format';
import { platformName, platformShort } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import { Composer, type ComposerHandle } from './composer';
import {
  KIND_LABEL,
  memberName,
  relative,
  slaState,
  snoozePresets,
  whoIs,
  type CannedReply,
  type Member,
} from './inbox-shared';

export type ThreadHandle = {
  focusReply(): void;
  focusNote(): void;
  openAssign(): void;
  openSnooze(): void;
  close(): void;
};

export const ThreadPane = forwardRef<
  ThreadHandle,
  {
    id: string;
    members: Member[];
    canned: CannedReply[];
    canTriage: boolean;
    canNote: boolean;
    selfId: string;
  }
>(function ThreadPane({ id, members, canned, canTriage, canNote, selfId }, ref) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const thread = useQuery(trpc.conversation.get.queryOptions({ id }));
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.conversation.get.queryKey({ id }) });
    void qc.invalidateQueries({ queryKey: trpc.conversation.list.pathKey() });
  };
  const markRead = useMutation(trpc.conversation.markRead.mutationOptions());
  const setStatus = useMutation(
    trpc.conversation.setStatus.mutationOptions({ onSuccess: invalidate }),
  );
  const assign = useMutation(trpc.conversation.assign.mutationOptions({ onSuccess: invalidate }));
  const snooze = useMutation(trpc.conversation.snooze.mutationOptions({ onSuccess: invalidate }));
  const setTags = useMutation(trpc.conversation.setTags.mutationOptions({ onSuccess: invalidate }));
  const [menu, setMenu] = useState<'assign' | 'snooze' | 'tags' | null>(null);
  const [customSnooze, setCustomSnooze] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const composerRef = useRef<ComposerHandle>(null);
  const assignRef = useRef<HTMLSelectElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focusReply: () => composerRef.current?.focusReply(),
    focusNote: () => composerRef.current?.focusNote(),
    openAssign: () => {
      setMenu('assign');
      setTimeout(() => assignRef.current?.focus(), 0);
    },
    openSnooze: () => setMenu((m) => (m === 'snooze' ? null : 'snooze')),
    close: () => {
      if (thread.data)
        setStatus.mutate({ id, status: thread.data.status === 'OPEN' ? 'CLOSED' : 'OPEN' });
    },
  }));

  useEffect(() => {
    if (thread.data && thread.data.unreadCount > 0) markRead.mutate({ id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark read once per thread load
  }, [thread.data?.unreadCount, id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.data?.messages.length, thread.data?.notes.length]);

  if (thread.isPending) return <p className="p-4 text-ink-muted">Loading…</p>;
  if (thread.error)
    return (
      <p role="alert" className="p-4 text-critical">
        {thread.error.message}
      </p>
    );
  const t = thread.data;
  const who = whoIs(t);
  const sla = slaState(t.slaDueAt);
  const items = [
    ...t.messages.map((m) => ({ kind: 'message' as const, at: new Date(m.sentAt).getTime(), m })),
    ...t.notes.map((n) => ({ kind: 'note' as const, at: new Date(n.createdAt).getTime(), n })),
  ].sort((a, b) => a.at - b.at);
  const error = setStatus.error ?? assign.error ?? snooze.error ?? setTags.error;

  return (
    <section
      aria-label={`Conversation with ${who}`}
      className="flex h-full min-h-0 flex-col rounded-[var(--radius-card)] border border-hairline bg-card"
      data-testid="thread"
    >
      <header className="flex flex-col gap-2 border-b border-hairline px-4 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[var(--text-md)] font-semibold">{who}</h2>
            <p className="truncate text-[var(--text-xs)] text-ink-muted">
              <span className="rounded-sm border border-hairline px-1 font-mono text-[10px] font-semibold">
                {platformShort(t.platform)}
              </span>{' '}
              {t.connection.label} · {KIND_LABEL[t.kind] ?? t.kind}
              {t.parentExternalId ? (
                <>
                  {' '}
                  · on {t.kind === 'COMMENT_THREAD' ? 'post' : 'object'}{' '}
                  <span className="font-mono">{t.parentExternalId}</span>
                </>
              ) : null}
              {t.status !== 'OPEN' ? ` · ${t.status.toLowerCase()}` : ''}
              {t.status === 'SNOOZED' && t.snoozedUntil
                ? ` until ${new Date(t.snoozedUntil).toLocaleString()}`
                : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-[var(--text-xs)]">
            {sla.tone !== 'none' ? (
              <span
                data-testid="sla-chip"
                className={`rounded-[var(--radius-pill)] px-1.5 py-0.5 ${sla.tone === 'breached' ? 'border border-critical font-medium text-critical' : sla.tone === 'soon' ? 'border border-hairline font-medium text-warning' : 'border border-hairline text-ink-secondary'}`}
              >
                {sla.tone === 'breached' ? '! ' : sla.tone === 'soon' ? '△ ' : '✓ '}
                {sla.label}
              </span>
            ) : t.firstResponseAt ? (
              <span
                className="rounded-[var(--radius-pill)] border border-hairline px-1.5 py-0.5 text-ink-muted"
                title={`First response ${new Date(t.firstResponseAt).toLocaleString()}`}
              >
                ✓ answered
              </span>
            ) : null}
            {canTriage ? (
              <>
                <Button
                  size="sm"
                  variant={menu === 'assign' ? 'primary' : 'secondary'}
                  aria-expanded={menu === 'assign'}
                  onClick={() => setMenu(menu === 'assign' ? null : 'assign')}
                  data-testid="assign-button"
                >
                  {t.assignee ? `Assigned: ${memberName(t.assignee)}` : 'Assign'}
                </Button>
                <Button
                  size="sm"
                  variant={menu === 'snooze' ? 'primary' : 'secondary'}
                  aria-expanded={menu === 'snooze'}
                  onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')}
                >
                  Snooze
                </Button>
                <Button
                  size="sm"
                  variant={menu === 'tags' ? 'primary' : 'secondary'}
                  aria-expanded={menu === 'tags'}
                  onClick={() => setMenu(menu === 'tags' ? null : 'tags')}
                >
                  Tags{t.tags.length ? ` (${t.tags.length})` : ''}
                </Button>
                {t.status === 'OPEN' ? (
                  <Button
                    size="sm"
                    onClick={() => setStatus.mutate({ id, status: 'CLOSED' })}
                    disabled={setStatus.isPending}
                  >
                    Close
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setStatus.mutate({ id, status: 'OPEN' })}
                    disabled={setStatus.isPending}
                  >
                    Reopen
                  </Button>
                )}
                {t.status !== 'SPAM' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setStatus.mutate({ id, status: 'SPAM' })}
                    disabled={setStatus.isPending}
                  >
                    Spam
                  </Button>
                ) : null}
              </>
            ) : t.assignee ? (
              <span className="text-ink-muted">Assigned: {memberName(t.assignee)}</span>
            ) : null}
          </div>
        </div>
        {menu === 'assign' ? (
          <div
            className="flex flex-wrap items-center gap-2 text-[var(--text-xs)]"
            role="group"
            aria-label="Assign"
          >
            <select
              ref={assignRef}
              aria-label="Assignee"
              value={t.assignee?.id ?? ''}
              onChange={(e) => {
                assign.mutate({ id, userId: e.target.value || null });
                setMenu(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMenu(null);
              }}
              className="h-7 rounded-[var(--radius-control)] border border-hairline bg-raised px-1.5 text-ink"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {memberName(m)}
                  {m.userId === selfId ? ' (me)' : ''}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                assign.mutate({ id, userId: selfId });
                setMenu(null);
              }}
            >
              Assign to me
            </Button>
          </div>
        ) : null}
        {menu === 'snooze' ? (
          <div
            className="flex flex-wrap items-center gap-1.5 text-[var(--text-xs)]"
            role="group"
            aria-label="Snooze"
          >
            {snoozePresets().map((p) => (
              <Button
                key={p.label}
                size="sm"
                onClick={() => {
                  snooze.mutate({ id, until: p.until });
                  setMenu(null);
                }}
              >
                {p.label}
              </Button>
            ))}
            <input
              type="datetime-local"
              aria-label="Snooze until"
              value={customSnooze}
              onChange={(e) => setCustomSnooze(e.target.value)}
              className="h-7 rounded-[var(--radius-control)] border border-hairline bg-raised px-1.5 text-ink"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!customSnooze}
              onClick={() => {
                snooze.mutate({ id, until: new Date(customSnooze) });
                setMenu(null);
              }}
            >
              Snooze
            </Button>
          </div>
        ) : null}
        {menu === 'tags' ? (
          <form
            className="flex flex-wrap items-center gap-1.5 text-[var(--text-xs)]"
            aria-label="Tags"
            onSubmit={(e) => {
              e.preventDefault();
              const v = tagDraft.trim().toLowerCase();
              if (!v) return;
              setTags.mutate({ id, tags: [...t.tags, v] });
              setTagDraft('');
            }}
          >
            {t.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-hairline px-2 py-0.5"
              >
                #{tag}
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => setTags.mutate({ id, tags: t.tags.filter((x) => x !== tag) })}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              aria-label="New tag"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              placeholder="Add tag"
              className="h-7 w-32 rounded-[var(--radius-control)] border border-hairline bg-raised px-1.5 text-ink"
            />
            <Button type="submit" size="sm">
              Add
            </Button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-[var(--text-xs)] text-critical">
            {error.message}
          </p>
        ) : null}
      </header>

      <ol
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4"
        aria-label="Messages"
        style={{ maxHeight: 'calc(100vh - 26rem)' }}
      >
        {items.map((it) =>
          it.kind === 'message' ? (
            <li
              key={it.m.id}
              className={`flex flex-col ${it.m.direction === 'OUTBOUND' ? 'items-end' : 'items-start'}`}
              data-testid={`message-${it.m.direction.toLowerCase()}`}
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-[var(--radius-card)] px-3 py-2 text-[var(--text-sm)] ${it.m.direction === 'OUTBOUND' ? 'bg-link text-ink-inverse' : 'bg-raised'}`}
              >
                {it.m.body}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[var(--text-xs)] text-ink-muted">
                <span
                  className="rounded-sm border border-hairline px-1 font-mono text-[10px]"
                  title={platformName(t.platform)}
                >
                  {platformShort(t.platform)}
                </span>
                {it.m.direction === 'OUTBOUND' ? (
                  <span>{it.m.authorUser?.name ?? it.m.authorUser?.email ?? 'You'}</span>
                ) : (
                  <span>{who}</span>
                )}
                <time
                  dateTime={isoOf(it.m.sentAt) ?? ''}
                  title={new Date(it.m.sentAt).toLocaleString()}
                >
                  {relative(it.m.sentAt)}
                </time>
                {it.m.outboundAction && it.m.outboundAction.status !== 'SENT' ? (
                  <span className={it.m.outboundAction.status === 'FAILED' ? 'text-critical' : ''}>
                    {it.m.outboundAction.status.toLowerCase()}
                    {it.m.outboundAction.errorMessage
                      ? `: ${it.m.outboundAction.errorMessage}`
                      : ''}
                  </span>
                ) : it.m.direction === 'OUTBOUND' ? (
                  <span>{it.m.deliveryState.toLowerCase()}</span>
                ) : null}
                {it.m.sourceUrl ? (
                  <a
                    href={it.m.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-link underline-offset-2 hover:underline"
                  >
                    View on {platformName(t.platform)}
                  </a>
                ) : null}
              </div>
            </li>
          ) : (
            <li key={it.n.id} className="flex flex-col items-stretch" data-testid="internal-note">
              <div className="rounded-[var(--radius-card)] border border-hairline bg-[var(--status-warning-bg)] px-3 py-2 text-[var(--text-sm)]">
                <div className="mb-0.5 text-[var(--text-xs)] text-ink-muted">
                  Internal note · {it.n.author?.name ?? it.n.author?.email ?? 'someone'} ·{' '}
                  <LocalDateTime iso={isoOf(it.n.createdAt) ?? ''} />
                  {it.n.mentions.length ? ` · mentions ${it.n.mentions.length}` : ''}
                </div>
                <p className="whitespace-pre-wrap">{it.n.body}</p>
              </div>
            </li>
          ),
        )}
        <div ref={endRef} />
      </ol>
      <Composer ref={composerRef} thread={t} canned={canned} members={members} canNote={canNote} />
    </section>
  );
});
