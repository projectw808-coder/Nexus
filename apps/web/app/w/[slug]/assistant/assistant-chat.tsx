'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/button';
import { useTRPC } from '@/lib/trpc-client';

type Turn = {
  role: 'user' | 'assistant';
  text: string;
  tool?: 'none' | 'create_client' | 'update_client';
  link?: { href: string; label: string };
};

const STARTER_PROMPTS = [
  'Add a new client named Jordan Lee, email jordan@example.com, source referral.',
  "What's connected right now?",
  'Mark Marcus Webb as qualified.',
];

export function AssistantChat({ workspaceSlug }: { workspaceSlug: string }) {
  const trpc = useTRPC();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const chat = useMutation(
    trpc.assistant.chat.mutationOptions({
      onSuccess: (r) => {
        setError(null);
        const target = r.created ?? r.updated;
        setTurns((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: r.reply,
            tool: r.tool,
            link: target
              ? { href: `/w/${workspaceSlug}/records/client/${target.id}`, label: target.label }
              : undefined,
          },
        ]);
      },
      onError: (e) => setError(e.message),
    }),
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, chat.isPending]);

  function send(message: string) {
    if (!message.trim() || chat.isPending) return;
    setTurns((prev) => [...prev, { role: 'user', text: message }]);
    setText('');
    setError(null);
    chat.mutate({
      message,
      history: turns.slice(-10).map((t) => ({ role: t.role, content: t.text })),
    });
  }

  return (
    <div className="flex min-h-[420px] flex-1 flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {turns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-[var(--text-sm)] text-ink-muted">
              Try asking it to add a client, update one, or check what's connected.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-[var(--text-xs)] text-ink-secondary hover:border-strong"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {turns.map((t, i) => (
              <li
                key={i}
                data-testid="assistant-turn"
                className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-[var(--radius-card)] px-3 py-2 text-[var(--text-sm)] ${
                    t.role === 'user'
                      ? 'bg-ink text-ink-inverse'
                      : 'border border-hairline bg-raised text-ink'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{t.text}</p>
                  {t.link ? (
                    <Link
                      href={t.link.href}
                      className="mt-1 inline-block text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                    >
                      Open {t.link.label} →
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {chat.isPending ? <p className="text-[var(--text-xs)] text-ink-muted">Thinking…</p> : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <p role="alert" className="text-[var(--text-xs)] text-critical">
          {error}
        </p>
      ) : null}

      <form
        className="flex items-end gap-2 border-t border-hairline pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              send(text);
            }
          }}
          rows={2}
          placeholder="Ask the assistant…"
          className="flex-1 resize-none rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 text-[var(--text-sm)] text-ink"
        />
        <Button type="submit" variant="primary" disabled={chat.isPending || !text.trim()}>
          {chat.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
    </div>
  );
}
