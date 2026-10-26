'use client';

import { useSyncExternalStore } from 'react';
import { dayLabel } from '@/lib/clients';

const subscribe = () => () => {};

/**
 * "Today, 14:22"-style label in the viewer's time zone. The server render and the hydration pass
 * both print the UTC label (so they match); the local one swaps in right after, with no effect.
 */
export function DayLabel({ iso }: { iso: string | null }) {
  const text = useSyncExternalStore(
    subscribe,
    () => dayLabel(iso),
    () => dayLabel(iso, new Date(), true),
  );
  return iso ? <time dateTime={iso}>{text}</time> : <>{text}</>;
}
