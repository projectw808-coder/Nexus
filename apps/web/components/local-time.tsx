'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

const serverFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function serverText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${serverFormat.format(d)} UTC`;
}

function localText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/**
 * A DATETIME rendered in the viewer's locale and time zone. The server (and the hydration
 * pass) print a fixed UTC string; `useSyncExternalStore` swaps in the local one after hydration
 * without a state update in an effect, so there is no mismatch and no flash of empty text.
 */
export function LocalDateTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => localText(iso),
    () => serverText(iso),
  );
  return <time dateTime={iso}>{text}</time>;
}
