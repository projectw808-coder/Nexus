'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { useTRPC } from '@/lib/trpc-client';

/**
 * Keitaro connects with a base URL and an API key, not a redirect (§8.6, ADR-019) — there is no
 * OAuth flow for `authKind: 'api_key'`. On success the mutation returns a postback URL carrying
 * the connection's webhook secret; the customer pastes it into their tracker's stream/campaign
 * settings so conversions arrive within seconds instead of waiting for the next poll.
 */
export function KeitaroConnectForm() {
  const trpc = useTRPC();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [postbackUrl, setPostbackUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connect = useMutation(
    trpc.connection.connectApiKey.mutationOptions({
      onSuccess: (result) => {
        setPostbackUrl(result.postbackUrl);
        setApiKey('');
        router.refresh();
      },
    }),
  );

  if (postbackUrl) {
    return (
      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-4">
        <p className="text-[var(--text-sm)] font-medium text-good">
          <span aria-hidden>✓ </span>Connected. Paste this postback URL into your Keitaro stream or
          campaign settings so conversions arrive in seconds:
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={postbackUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 font-mono text-[var(--text-xs)] text-ink"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(postbackUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            setPostbackUrl(null);
            setBaseUrl('');
          }}
        >
          Connect another tracker
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!baseUrl.trim() || !apiKey.trim()) return;
        connect.mutate({ platform: 'KEITARO', baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
      }}
    >
      <h3 className="text-[var(--text-sm)] font-semibold tracking-tight">Connect Keitaro</h3>
      <p className="text-[var(--text-xs)] text-ink-muted">
        Create a key in your tracker under Account → API keys, then paste its base URL and key here
        — Keitaro has no sign-in redirect.
      </p>
      <label className="flex flex-col gap-1 text-[var(--text-sm)]">
        Tracker base URL
        <input
          type="url"
          required
          placeholder="https://tracker.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[var(--text-sm)]">
        API key
        <input
          type="password"
          required
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 font-mono text-ink"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={connect.isPending || !baseUrl.trim() || !apiKey.trim()}
        >
          {connect.isPending ? 'Connecting…' : 'Connect'}
        </Button>
        {connect.error ? (
          <span role="alert" className="text-[var(--text-sm)] text-critical">
            {connect.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
