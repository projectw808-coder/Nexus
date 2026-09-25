'use client';

/**
 * Subscribe to the workspace's realtime stream (`/api/events`). Handlers get the topic and the
 * ids that changed and decide what to refetch; EventSource reconnects on its own.
 */
import { useEffect, useRef } from 'react';

export type RealtimeEvent = {
  workspaceId: string;
  topic: string;
  payload: Record<string, unknown>;
  at: string;
};

export function useRealtime(
  slug: string,
  topics: string[],
  handler: (event: RealtimeEvent) => void,
  opts: { enabled?: boolean } = {},
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const key = topics.join(',');
  useEffect(() => {
    if (opts.enabled === false || typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/events?workspace=${encodeURIComponent(slug)}`);
    const listeners = key.split(',').map((topic) => {
      const fn = (e: MessageEvent<string>) => {
        try {
          latest.current(JSON.parse(e.data) as RealtimeEvent);
        } catch {
          /* malformed frame */
        }
      };
      source.addEventListener(topic, fn);
      return [topic, fn] as const;
    });
    return () => {
      for (const [topic, fn] of listeners) source.removeEventListener(topic, fn);
      source.close();
    };
  }, [slug, key, opts.enabled]);
}
