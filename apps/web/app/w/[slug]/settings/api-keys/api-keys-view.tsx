'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { messageOf } from '@/lib/errors';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type ApiKey = RouterOutputs['apiKey']['list'][number];
type Scope = ApiKey['scopes'][number];

const SCOPES: { id: Scope; label: string; description: string }[] = [
  { id: 'READ', label: 'Read', description: 'List and fetch records, conversations, connections.' },
  {
    id: 'WRITE',
    label: 'Write',
    description: 'Create and change data, send replies, sync. Implies Read.',
  },
  {
    id: 'ADMIN',
    label: 'Admin',
    description: 'Everything Write can do, plus future administrative endpoints.',
  },
];

function formatWhen(value: Date | string | null): string {
  if (!value) return 'never';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

/** Shown exactly once, immediately after creation — nothing stores the plaintext. */
function NewKeyBanner({ plaintext, onDismiss }: { plaintext: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-strong bg-raised p-4"
    >
      <h3 className="text-[var(--text-md)] font-semibold tracking-tight">
        Copy this key now — you will not see it again
      </h3>
      <p className="text-[var(--text-sm)] text-ink-secondary">
        Only a SHA-256 hash of the key is stored. If you lose it, revoke this key and create another
        one.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="grow overflow-x-auto rounded-[var(--radius-control)] border border-hairline bg-card px-3 py-2 font-mono text-[var(--text-sm)]">
          {plaintext}
        </code>
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard
              .writeText(plaintext)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function ApiKeysView({ initial, canManage }: { initial: ApiKey[]; canManage: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery({ ...trpc.apiKey.list.queryOptions(), initialData: initial });
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.apiKey.list.pathKey() });

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['READ']);
  const [rateLimit, setRateLimit] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const create = useMutation(
    trpc.apiKey.create.mutationOptions({
      onSuccess: (created) => {
        setPlaintext(created.plaintext);
        setName('');
        setScopes(['READ']);
        setRateLimit('');
        invalidate();
      },
    }),
  );
  const revoke = useMutation(trpc.apiKey.revoke.mutationOptions({ onSuccess: invalidate }));
  const error = create.error ?? revoke.error;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-[var(--text-sm)] text-ink-secondary">
        An API key authenticates calls to the public REST API as this workspace:{' '}
        <code className="font-mono">Authorization: Bearer nx_live_…</code>. The key fixes the
        workspace, so no request needs to name one. The contract lives at{' '}
        <a className="underline" href="/api/v1/openapi.json">
          /api/v1/openapi.json
        </a>
        .
      </p>

      {plaintext ? (
        <NewKeyBanner plaintext={plaintext} onDismiss={() => setPlaintext(null)} />
      ) : null}

      {canManage ? (
        <form
          className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || scopes.length === 0) return;
            const parsed = Number(rateLimit);
            create.mutate({
              name: name.trim(),
              scopes,
              rateLimitPerMinute: rateLimit.trim() && Number.isFinite(parsed) ? parsed : null,
            });
          }}
        >
          <h2 className="text-[var(--text-md)] font-semibold tracking-tight">New API key</h2>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="Zapier integration"
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-ink"
            />
          </label>
          <fieldset className="flex flex-col gap-1.5 text-[var(--text-sm)]">
            <legend className="mb-1">Scopes</legend>
            {SCOPES.map((s) => (
              <label key={s.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={scopes.includes(s.id)}
                  onChange={(e) =>
                    setScopes((prev) =>
                      e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                    )
                  }
                />
                <span>
                  <span className="font-medium">{s.label}</span>{' '}
                  <span className="text-ink-muted">{s.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Rate limit{' '}
            <span className="text-ink-muted">(requests per minute; blank for the default)</span>
            <input
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              className="w-40 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-ink tnum"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending || !name.trim() || scopes.length === 0}
            >
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
            {error ? (
              <span role="alert" className="text-[var(--text-sm)] text-critical">
                {messageOf(error)}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <section aria-labelledby="keys-heading" className="flex flex-col gap-3">
        <h2 id="keys-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Keys <span className="tnum font-normal text-ink-muted">({list.data.length})</span>
        </h2>
        {list.data.length === 0 ? (
          <EmptyState
            compact
            title="No API keys yet"
            description="Create one to let an external system read and write this workspace through the REST API."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {list.data.map((k) => (
              <li key={k.id} className="flex flex-col gap-1 px-4 py-2.5 text-[var(--text-sm)]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{k.name}</span>
                  <code className="font-mono text-[var(--text-xs)] text-ink-muted">
                    {k.prefix}…
                  </code>
                  <span className="text-[var(--text-xs)] text-ink-muted">
                    {k.scopes.join(' · ')}
                  </span>
                  {k.revokedAt ? (
                    <span className="text-[var(--text-xs)] text-critical">Revoked</span>
                  ) : null}
                  {canManage && !k.revokedAt ? (
                    <Button
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      onClick={() => revoke.mutate({ id: k.id })}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
                <p className="text-ink-secondary">
                  Last used {formatWhen(k.lastUsedAt)}
                  {k.rateLimitPerMinute ? ` · ${k.rateLimitPerMinute} req/min` : ''}
                  {k.expiresAt ? ` · expires ${formatWhen(k.expiresAt)}` : ''}
                  {k.createdBy ? ` · created by ${k.createdBy.name ?? k.createdBy.email}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
