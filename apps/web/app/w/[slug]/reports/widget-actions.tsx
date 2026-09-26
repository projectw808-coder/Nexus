'use client';

/** Per-tile edit/remove, kept out of the chart itself so the chart stays a pure presentation. */
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/button';
import { useTRPC } from '@/lib/trpc-client';

export function WidgetActions({
  slug,
  dashboardId,
  widgetId,
  title,
}: {
  slug: string;
  dashboardId: string;
  widgetId: string;
  title: string;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation(
    trpc.widget.delete.mutationOptions({
      onSuccess: () => router.refresh(),
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <div className="flex items-center justify-end gap-2">
      {error ? (
        <p role="alert" className="mr-auto text-[var(--text-xs)] text-critical">
          {error}
        </p>
      ) : null}
      <Link
        href={`/w/${slug}/reports/${dashboardId}/widgets/${widgetId}`}
        className="text-[var(--text-xs)] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Edit
      </Link>
      <Button
        size="sm"
        variant="ghost"
        disabled={remove.isPending}
        onClick={() => {
          if (!window.confirm(`Remove "${title}" from this dashboard?`)) return;
          remove.mutate({ id: widgetId });
        }}
      >
        {remove.isPending ? 'Removing…' : 'Remove'}
      </Button>
    </div>
  );
}
