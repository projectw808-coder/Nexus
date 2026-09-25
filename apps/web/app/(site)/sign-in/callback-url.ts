/**
 * Only same-origin relative paths are honoured as a post-sign-in destination. Anything else
 * (absolute URLs, protocol-relative `//evil`, non-strings) falls back to `/`.
 */
export function safeCallbackUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
