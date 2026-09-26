'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { useTRPC } from '@/lib/trpc-client';

export function DangerView({
  workspaceSlug,
  connectionId,
  connectionLabel,
}: {
  workspaceSlug: string;
  connectionId: string;
  connectionLabel: string;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [confirmLabel, setConfirmLabel] = useState('');
  const disconnect = useMutation(
    trpc.connection.disconnect.mutationOptions({
      onSuccess: () => router.push(`/w/${workspaceSlug}/settings/integrations`),
    }),
  );

  return (
    <Card className="flex flex-col gap-3 border-critical p-4">
      <h2 className="text-[var(--text-sm)] font-semibold tracking-tight text-critical">
        Disconnect &amp; purge
      </h2>
      <p className="text-[var(--text-sm)] text-ink-secondary">
        Revokes access on the platform (best effort), deletes the stored credentials, and
        soft-deletes every raw object and sync cursor for this connection. This cannot be reversed
        from here. Type the connection's label to confirm:{' '}
        <span className="font-mono font-medium text-ink">{connectionLabel}</span>
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          disconnect.mutate({ id: connectionId, confirmLabel });
        }}
      >
        <input
          aria-label="Type the connection label to confirm"
          value={confirmLabel}
          onChange={(e) => setConfirmLabel(e.target.value)}
          placeholder={connectionLabel}
          className="min-w-64 flex-1 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 font-mono text-[var(--text-sm)]"
        />
        <Button
          type="submit"
          variant="danger"
          disabled={disconnect.isPending || confirmLabel !== connectionLabel}
        >
          {disconnect.isPending ? 'Disconnecting…' : 'Disconnect & purge'}
        </Button>
      </form>
      {disconnect.error ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {disconnect.error.message}
        </p>
      ) : null}
    </Card>
  );
}
