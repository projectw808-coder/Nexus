'use client';

/**
 * The platform-aware composer (§12.2.A): a character counter from the connector manifest,
 * the allowed attachment types, the live messaging-window countdown, an explicit disabled
 * state with the reason, canned replies (button or `/shortcut`), an internal-notes tab with
 * @mentions, and which account the reply goes out as. AI drafts arrive with Phase 10.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/button';
import { useTRPC } from '@/lib/trpc-client';
import { memberName, newNonce, type CannedReply, type Member, type Thread } from './inbox-shared';

export type ComposerHandle = { focusReply(): void; focusNote(): void };

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

export const Composer = forwardRef<
  ComposerHandle,
  {
    thread: Thread;
    canned: CannedReply[];
    members: Member[];
    canNote: boolean;
    onSent?: () => void;
  }
>(function Composer({ thread: t, canned, members, canNote, onSent }, ref) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [mentions, setMentions] = useState<Member[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [showCanned, setShowCanned] = useState(false);
  const [isAiDraft, setIsAiDraft] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [nonce, setNonce] = useState(() => newNonce());
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    focusReply() {
      setTab('reply');
      setTimeout(() => replyRef.current?.focus(), 0);
    },
    focusNote() {
      setTab('note');
      setTimeout(() => noteRef.current?.focus(), 0);
    },
  }));
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.conversation.get.queryKey({ id: t.id }) });
    void qc.invalidateQueries({ queryKey: trpc.conversation.list.pathKey() });
  };
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
        invalidate();
        onSent?.();
      },
      onError: (e) => setNotice({ tone: 'error', text: e.message }),
    }),
  );
  const draftReply = useMutation(
    trpc.ai.draftReply.mutationOptions({
      onSuccess: (d) => {
        setText(d.text);
        setIsAiDraft(true);
        setTab('reply');
      },
      onError: (e) => setNotice({ tone: 'error', text: e.message }),
    }),
  );
  const addNote = useMutation(
    trpc.note.create.mutationOptions({
      onSuccess: () => {
        setNote('');
        setMentions([]);
        invalidate();
      },
      onError: (e) => setNotice({ tone: 'error', text: e.message }),
    }),
  );
  const countdown = useCountdown(
    t.kind === 'DM' ? (t.replyWindowExpiresAt ? new Date(t.replyWindowExpiresAt) : null) : null,
  );
  const max = t.composer.maxChars;
  const over = max !== null && text.length > max;
  const blocked = !t.canReply || countdown.expired;
  const reason = !t.canReply
    ? t.connection.status === 'CONNECTED' || t.connection.status === 'DEGRADED'
      ? 'Replies need a role that can update conversations.'
      : `Replies are paused: the ${t.connection.label} connection is ${t.connection.status.toLowerCase().replace('_', ' ')}.`
    : countdown.expired
      ? `The ${t.windowHours ?? 24}-hour messaging window closed on ${t.replyWindowExpiresAt ? new Date(t.replyWindowExpiresAt).toLocaleString() : 'the platform'}. The platform only allows replies within ${t.windowHours ?? 24} hours of the customer's last message; it reopens when they write again.`
      : null;
  const send = () => {
    if (blocked || over || !text.trim() || reply.isPending) return;
    reply.mutate({ id: t.id, text: text.trim(), requestNonce: nonce });
  };
  const saveNote = () => {
    if (!note.trim() || addNote.isPending) return;
    addNote.mutate({
      conversationId: t.id,
      body: note.trim(),
      mentions: mentions.map((m) => m.userId),
    });
  };
  const applyCanned = (c: CannedReply) => {
    setText((v) => (v.trim() ? `${v}\n${c.body}` : c.body));
    setShowCanned(false);
    replyRef.current?.focus();
  };
  const onReplyChange = (v: string) => {
    // A human edit means it's no longer purely an AI draft (§13 "never auto-sends" — the badge
    // marks unreviewed AI text, not text a human has touched).
    setIsAiDraft(false);
    // `/shortcut ` expands a canned reply.
    const m = /(^|\s)\/([a-z0-9_-]{1,32})\s$/i.exec(v);
    if (m) {
      const hit = canned.find(
        (c) => c.shortcut && c.shortcut.toLowerCase() === m[2]!.toLowerCase(),
      );
      if (hit) {
        setText(v.slice(0, v.length - m[0].length) + (m[1] ?? '') + hit.body);
        return;
      }
    }
    setText(v);
  };
  const onNoteChange = (v: string) => {
    setNote(v);
    const m = /@([a-z0-9._-]*)$/i.exec(v);
    setMentionQuery(m ? (m[1] ?? '') : null);
  };
  const mentionHits =
    mentionQuery !== null
      ? members
          .filter((mm) => memberName(mm).toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 5)
      : [];
  const pickMention = (m: Member) => {
    setNote((v) => v.replace(/@([a-z0-9._-]*)$/i, `@${memberName(m)} `));
    setMentions((ms) => (ms.some((x) => x.userId === m.userId) ? ms : [...ms, m]));
    setMentionQuery(null);
    noteRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-hairline p-3" data-testid="composer">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--text-xs)] text-ink-muted">
        <div role="tablist" aria-label="Composer mode" className="flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reply'}
            onClick={() => setTab('reply')}
            className={`rounded-[var(--radius-control)] px-2 py-0.5 ${tab === 'reply' ? 'bg-ink text-ink-inverse' : 'hover:bg-raised'}`}
          >
            Reply
          </button>
          {canNote ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'note'}
              onClick={() => setTab('note')}
              className={`rounded-[var(--radius-control)] px-2 py-0.5 ${tab === 'note' ? 'bg-ink text-ink-inverse' : 'hover:bg-raised'}`}
            >
              Internal note
            </button>
          ) : null}
        </div>
        {tab === 'reply' ? (
          <span className="flex flex-wrap items-center gap-3">
            <span>Sending as {t.composer.sendAs}</span>
            {t.kind === 'DM' && t.replyWindowExpiresAt ? (
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
          </span>
        ) : (
          <span>Notes are internal — the customer never sees them.</span>
        )}
      </div>

      {tab === 'reply' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`reply-${t.id}`} className="sr-only">
            Reply
          </label>
          {isAiDraft ? (
            <span
              data-testid="ai-draft-badge"
              className="inline-flex w-fit items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--status-warning-bg)] px-2 py-0.5 text-[var(--text-xs)] font-medium text-warning"
            >
              AI draft — review before sending
            </span>
          ) : null}
          <textarea
            ref={replyRef}
            id={`reply-${t.id}`}
            value={text}
            onChange={(e) => onReplyChange(e.target.value)}
            disabled={blocked}
            rows={3}
            placeholder={
              blocked
                ? 'Replying is not available'
                : 'Write a reply… (Ctrl+Enter to send, /shortcut for a canned reply)'
            }
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
            className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-[var(--text-sm)] text-ink disabled:opacity-60"
          />
          {reason ? (
            <p
              role="status"
              className="text-[var(--text-xs)] text-critical"
              data-testid="reply-blocked"
            >
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
          <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--text-xs)] text-ink-muted">
            <span className="flex flex-wrap items-center gap-2">
              <span className={`tnum ${over ? 'text-critical' : ''}`} aria-live="polite">
                {text.length}
                {max !== null ? ` / ${max}` : ''}
              </span>
              <span>
                {t.composer.attachmentTypes.length
                  ? `Attachments: ${t.composer.attachmentTypes.join(', ')}`
                  : 'Attachments: text only on this platform for now'}
              </span>
              <button
                type="button"
                onClick={() => draftReply.mutate({ conversationId: t.id })}
                disabled={draftReply.isPending || blocked}
                className="text-link underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {draftReply.isPending ? 'Drafting…' : 'AI draft'}
              </button>
              {canned.length ? (
                <span className="relative">
                  <button
                    type="button"
                    aria-expanded={showCanned}
                    onClick={() => setShowCanned((v) => !v)}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    Canned replies
                  </button>
                  {showCanned ? (
                    <ul
                      role="menu"
                      className="absolute bottom-6 left-0 z-20 w-72 rounded-[var(--radius-card)] border border-hairline bg-raised p-1 shadow-[var(--elevation-2)]"
                    >
                      {canned.map((c) => (
                        <li key={c.id} role="none">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => applyCanned(c)}
                            className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-card"
                          >
                            <span className="text-ink">
                              {c.title}
                              {c.shortcut ? (
                                <span className="ml-1 font-mono text-ink-muted">/{c.shortcut}</span>
                              ) : null}
                            </span>
                            <span className="truncate text-ink-muted">{c.body}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </span>
              ) : null}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={blocked || over || !text.trim() || reply.isPending}
            >
              {reply.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveNote();
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`note-${t.id}`} className="sr-only">
            Internal note
          </label>
          <div className="relative">
            <textarea
              ref={noteRef}
              id={`note-${t.id}`}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              rows={3}
              placeholder="Add an internal note… (@ to mention a teammate, Ctrl+Enter to save)"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  saveNote();
                }
                if (e.key === 'Escape') setMentionQuery(null);
              }}
              className="w-full rounded-[var(--radius-control)] border border-hairline bg-[var(--status-warning-bg)] px-3 py-2 text-[var(--text-sm)] text-ink"
            />
            {mentionHits.length ? (
              <ul
                role="listbox"
                aria-label="Mention a teammate"
                className="absolute left-2 top-full z-20 mt-1 w-64 rounded-[var(--radius-card)] border border-hairline bg-raised p-1 shadow-[var(--elevation-2)]"
              >
                {mentionHits.map((m) => (
                  <li key={m.userId} role="option" aria-selected={false}>
                    <button
                      type="button"
                      onClick={() => pickMention(m)}
                      className="w-full rounded px-2 py-1 text-left text-[var(--text-sm)] hover:bg-card"
                    >
                      {memberName(m)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {mentions.length ? (
            <p className="text-[var(--text-xs)] text-ink-muted">
              Mentions: {mentions.map((m) => `@${memberName(m)}`).join(', ')}
            </p>
          ) : null}
          {notice?.tone === 'error' ? (
            <p role="alert" className="text-[var(--text-xs)] text-critical">
              {notice.text}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!note.trim() || addNote.isPending}
            >
              {addNote.isPending ? 'Saving…' : 'Add note'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
});
