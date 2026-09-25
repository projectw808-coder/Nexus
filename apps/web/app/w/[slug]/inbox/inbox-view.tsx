'use client';

/**
 * The bare inbox: a polling conversation list (5 s — a webhook-delivered DM appears well
 * inside the 10 s the acceptance asks for), the selected thread, and a composer that shows
 * the live messaging-window countdown and refuses to send once it lapses, with the platform's
 * reason. Keyboard: ↑/↓ move between threads, Enter opens, Ctrl+Enter sends.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { useTRPC } from '@/lib/trpc-client';

type ListItem = {
  id: string;
  kind: string;
  status: string;
  subject: string | null;
  platform: string;
  connection: { id: string; label: string; platform: string; status: string };
  identity: { displayName: string | null; handle: string | null; externalId: string } | null;
  lastMessageAt: Date;
  unreadCount: number;
  lastMessage: {
    body: string;
    direction: string;
    sentAt: Date;
    replyWindowExpiresAt: Date | null;
  } | null;
};

const PLATFORM_SHORT: Record<string, string> = {
  FACEBOOK: 'FB',
  INSTAGRAM: 'IG',
  X: 'X',
  LINKEDIN: 'LI',
  TIKTOK: 'TT',
  YOUTUBE: 'YT',
  MOCK: 'MK',
};

function whoIs(c: ListItem): string {
  return (
    c.identity?.displayName ??
    (c.identity?.handle ? `@${c.identity.handle}` : (c.identity?.externalId ?? 'Unknown'))
  );
}

export function InboxView({
  slug,
  initialConversations,
  initialSelectedId,
  hasConnections,
}: {
  slug: string;
  initialConversations: ListItem[];
  initialSelectedId: string | null;
  hasConnections: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const list = useQuery({
    ...trpc.conversation.list.queryOptions({ limit: 50 }),
    initialData: initialConversations as never,
    refetchInterval: 5_000,
  });
  const conversations = (list.data ?? initialConversations) as ListItem[];

  const select = (id: string) => {
    setSelectedId(id);
    router.replace(`/w/${slug}/inbox?c=${id}`, { scroll: false });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const idx = conversations.findIndex((c) => c.id === selectedId);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = conversations[Math.min(conversations.length - 1, idx + 1)];
      if (next) select(next.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = conversations[Math.max(0, idx - 1)];
      if (prev) select(prev.id);
    }
  };

  if (conversations.length === 0) {
    return (
      <EmptyState
        title={
          hasConnections ? 'No conversations yet' : 'Connect a platform to start receiving messages'
        }
        description={
          hasConnections ? (
            'DMs, comments and mentions appear here within seconds of arriving on the platform.'
          ) : (
            <>
              Facebook Pages and Instagram are ready to connect from{' '}
              <Link className="text-link" href={`/w/${slug}/settings/integrations`}>
                Settings → Integrations
              </Link>
              .
            </>
          )
        }
      />
    );
  }

  return (
    <div className="grid min-h-[60vh] grid-cols-1 gap-4 md:grid-cols-[minmax(16rem,22rem)_1fr]">
      <ul
        role="listbox"
        aria-label="Conversations"
        tabIndex={0}
        onKeyDown={onListKey}
        className="flex max-h-[70vh] flex-col overflow-auto rounded-[var(--radius-card)] border border-hairline bg-card outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        {conversations.map((c) => (
          <li key={c.id} role="option" aria-selected={c.id === selectedId}>
            <button
              type="button"
              onClick={() => select(c.id)}
              className={`flex w-full flex-col gap-0.5 border-b border-hairline px-3 py-2 text-left hover:bg-raised ${c.id === selectedId ? 'bg-raised' : ''}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[var(--text-sm)] font-medium">
                  {c.unreadCount > 0 ? (
                    <span
                      className="mr-1 inline-block h-2 w-2 rounded-full bg-link"
                      aria-label={`${c.unreadCount} unread`}
                    />
                  ) : null}
                  {whoIs(c)}
                </span>
                <span
                  className="shrink-0 rounded-[var(--radius-pill)] border border-hairline px-1.5 text-[10px] leading-4 text-ink-muted"
                  title={c.connection.label}
                >
                  {PLATFORM_SHORT[c.platform] ?? c.platform} ·{' '}
                  {c.kind === 'DM' ? 'DM' : c.kind === 'MENTION' ? 'mention' : 'comment'}
                </span>
              </span>
              <span className="truncate text-[var(--text-xs)] text-ink-secondary">
                {c.lastMessage
                  ? `${c.lastMessage.direction === 'OUTBOUND' ? 'You: ' : ''}${c.lastMessage.body}`
                  : (c.subject ?? '')}
              </span>
              <span className="text-[var(--text-xs)] text-ink-muted">
                <LocalDateTime iso={new Date(c.lastMessageAt).toISOString()} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        {selectedId ? (
          <Thread key={selectedId} id={selectedId} />
        ) : (
          <EmptyState title="Pick a conversation" />
        )}
      </div>
    </div>
  );
}

function useCountdown(expiresAt: Date | null): { label: string; expired: boolean; msLeft: number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return { label: '', expired: false, msLeft: Number.POSITIVE_INFINITY };
  const msLeft = new Date(expiresAt).getTime() - now;
  if (msLeft <= 0) return { label: 'Window closed', expired: true, msLeft };
  const h = Math.floor(msLeft / 3600_000);
  const m = Math.floor((msLeft % 3600_000) / 60_000);
  const s = Math.floor((msLeft % 60_000) / 1000);
  return {
    label: `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s left`,
    expired: false,
    msLeft,
  };
}

function Thread({ id }: { id: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const thread = useQuery({
    ...trpc.conversation.get.queryOptions({ id }),
    refetchInterval: 5_000,
  });
  const markRead = useMutation(trpc.conversation.markRead.mutationOptions());
  const setStatus = useMutation(
    trpc.conversation.setStatus.mutationOptions({ onSuccess: () => void qc.invalidateQueries() }),
  );
  useEffect(() => {
    if (thread.data && thread.data.unreadCount > 0) markRead.mutate({ id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mark read once per thread load
  }, [thread.data?.unreadCount, id]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.data?.messages.length]);

  if (thread.isPending) return <p className="text-ink-muted">Loading…</p>;
  if (thread.error)
    return (
      <p role="alert" className="text-critical">
        {thread.error.message}
      </p>
    );
  const t = thread.data;
  const who =
    t.identity?.displayName ??
    (t.identity?.handle ? `@${t.identity.handle}` : (t.identity?.externalId ?? 'Unknown'));
  return (
    <section
      aria-label={`Conversation with ${who}`}
      className="flex h-full flex-col rounded-[var(--radius-card)] border border-hairline bg-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[var(--text-md)] font-semibold">{who}</h2>
          <p className="truncate text-[var(--text-xs)] text-ink-muted">
            {t.connection.label} ·{' '}
            {t.kind === 'DM'
              ? 'Direct message'
              : t.kind === 'MENTION'
                ? 'Mention'
                : 'Comment thread'}
            {t.parentExternalId ? ` · on ${t.parentExternalId}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2 text-[var(--text-xs)]">
          {t.status === 'OPEN' ? (
            <button
              type="button"
              className="rounded-[var(--radius-control)] border border-hairline px-2 py-1 hover:bg-raised"
              onClick={() => setStatus.mutate({ id, status: 'CLOSED' })}
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              className="rounded-[var(--radius-control)] border border-hairline px-2 py-1 hover:bg-raised"
              onClick={() => setStatus.mutate({ id, status: 'OPEN' })}
            >
              Reopen
            </button>
          )}
        </div>
      </header>
      <ol
        className="flex max-h-[50vh] flex-1 flex-col gap-2 overflow-auto p-4"
        aria-label="Messages"
      >
        {t.messages.map((m) => (
          <li
            key={m.id}
            className={`flex flex-col ${m.direction === 'OUTBOUND' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-[var(--radius-card)] px-3 py-2 text-[var(--text-sm)] ${m.direction === 'OUTBOUND' ? 'bg-link text-ink-inverse' : 'bg-raised'}`}
            >
              {m.body}
            </div>
            <div className="mt-0.5 text-[var(--text-xs)] text-ink-muted">
              {m.direction === 'OUTBOUND'
                ? `${m.authorUser?.name ?? m.authorUser?.email ?? 'You'} · `
                : ''}
              <LocalDateTime iso={new Date(m.sentAt).toISOString()} />
              {m.outboundAction && m.outboundAction.status !== 'SENT'
                ? ` · ${m.outboundAction.status.toLowerCase()}${m.outboundAction.errorMessage ? `: ${m.outboundAction.errorMessage}` : ''}`
                : ''}
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
      <Composer
        conversationId={id}
        canReply={t.canReply}
        replyWindowExpiresAt={t.replyWindowExpiresAt ? new Date(t.replyWindowExpiresAt) : null}
        windowHours={t.windowHours}
        kind={t.kind}
      />
    </section>
  );
}

function newNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function Composer({
  conversationId,
  canReply,
  replyWindowExpiresAt,
  windowHours,
  kind,
}: {
  conversationId: string;
  canReply: boolean;
  replyWindowExpiresAt: Date | null;
  windowHours: number | null;
  kind: string;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  // One nonce per user intent: minted when the draft starts, replayed on retries, replaced after a send.
  const [nonce, setNonce] = useState(() => newNonce());
  const countdown = useCountdown(kind === 'DM' ? replyWindowExpiresAt : null);
  const reply = useMutation(
    trpc.conversation.reply.mutationOptions({
      onSuccess: (r) => {
        if (r.status === 'blocked') {
          setNotice({ tone: 'error', text: `${r.reason}. ${r.remediation}` });
          return;
        }
        setText('');
        setNonce(newNonce());
        setNotice(
          r.status === 'duplicate'
            ? { tone: 'ok', text: 'Already sent.' }
            : { tone: 'ok', text: r.warnings?.length ? r.warnings.join(' ') : 'Sending…' },
        );
        void qc.invalidateQueries();
      },
      onError: (e) => setNotice({ tone: 'error', text: e.message }),
    }),
  );
  const blocked = !canReply || countdown.expired;
  const reason = !canReply
    ? 'Replies need a role that can update conversations, on a connected account.'
    : countdown.expired
      ? `The ${windowHours ?? 24}-hour messaging window closed on ${replyWindowExpiresAt ? new Date(replyWindowExpiresAt).toLocaleString() : 'the platform'}. The platform only allows replies within ${windowHours ?? 24} hours of the customer's last message; it reopens when they write again.`
      : null;
  const send = () => {
    if (blocked || !text.trim() || reply.isPending) return;
    reply.mutate({ id: conversationId, text: text.trim(), requestNonce: nonce });
  };

  return (
    <form
      className="flex flex-col gap-2 border-t border-hairline p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="flex items-center justify-between text-[var(--text-xs)] text-ink-muted">
        <label htmlFor={`reply-${conversationId}`}>Reply</label>
        {kind === 'DM' && replyWindowExpiresAt ? (
          <span
            aria-live="polite"
            className={
              countdown.expired
                ? 'text-critical'
                : countdown.msLeft < 3600_000
                  ? 'text-warning'
                  : ''
            }
          >
            Messaging window: {countdown.label}
          </span>
        ) : null}
      </div>
      <textarea
        id={`reply-${conversationId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={blocked}
        rows={3}
        placeholder={blocked ? 'Replying is not available' : 'Write a reply… (Ctrl+Enter to send)'}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
        className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-[var(--text-sm)] text-ink disabled:opacity-60"
      />
      {reason ? (
        <p role="status" className="text-[var(--text-xs)] text-critical">
          {reason}
        </p>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`text-[var(--text-xs)] ${notice.tone === 'error' ? 'text-critical' : 'text-ink-secondary'}`}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={blocked || !text.trim() || reply.isPending}
          className="rounded-[var(--radius-control)] bg-link px-3 py-1.5 text-[var(--text-sm)] font-medium text-ink-inverse disabled:opacity-50"
        >
          {reply.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
