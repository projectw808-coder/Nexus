/**
 * Client-safe slug helpers. Mirrors `SLUG_PATTERN` in @nexus/db (which cannot be imported into
 * a client bundle because the package pulls in Prisma and node:crypto). The server validates
 * again; this is only for inline feedback.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const SLUG_HELP =
  '3–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.';

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
