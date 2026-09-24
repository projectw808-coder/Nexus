/**
 * Date formatting for server-rendered tables. A fixed locale and UTC keep the output stable
 * between renders; the `<time dateTime>` attribute carries the exact instant.
 */
const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const dateOnly = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return `${dateTime.format(date)} UTC`;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return dateOnly.format(date);
}

export function isoOf(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  return (typeof d === 'string' ? new Date(d) : d).toISOString();
}
