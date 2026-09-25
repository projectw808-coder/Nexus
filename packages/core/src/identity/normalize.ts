/**
 * Normalisers the resolver compares on (spec §10). Every comparison in `score.ts` runs on the
 * output of one of these so "the same" means the same thing everywhere: in the resolver, in the
 * candidate SQL and in the "why" panel.
 */

/** Lower-cased, trimmed e-mail; `null` when it is not shaped like one. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** Digits only, with a leading `+` when the input carried a country code (E.164 or `00`). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return international ? `+${digits}` : digits;
}

/**
 * Two normalised phones match when they are equal, or when one carries a country code and
 * the other is the same national number without it (`+447700900123` ≈ `07700900123`).
 */
export function phonesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const da = a.replace(/^\+/, '');
  const db = b.replace(/^\+/, '');
  if (da === db) return true;
  const [long, short] = da.length >= db.length ? [da, db] : [db, da];
  if (short.length < 9) return false;
  const national = short.replace(/^0/, '');
  return long.endsWith(national) && long.length - national.length <= 3;
}

/** Lower-cased handle without the leading `@`; dots and underscores are kept (Instagram). */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/^@+/, '').toLowerCase();
  return v.length >= 2 ? v : null;
}

/** Diacritics stripped, lower-cased, punctuation collapsed to single spaces. */
export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return v.length >= 2 ? v : null;
}

/** `acme.com` from `jane@acme.com`; `null` for free-mail providers (never a company signal). */
export function domainOfEmail(email: string | null | undefined): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const domain = e.slice(e.indexOf('@') + 1);
  return FREE_MAIL.has(domain) ? null : domain;
}

const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
]);

/** Host of a URL without `www.`, lower-cased; `null` when unparsable. */
export function domainOfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Canonical form of a profile URL for equality: scheme and `www.` dropped, host lower-cased,
 * trailing slash and query removed (`https://www.instagram.com/Jane/?hl=en` → `instagram.com/jane`).
 */
export function normalizeProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return path ? `${host}${path}` : null;
  } catch {
    return null;
  }
}

/** Every http(s) URL mentioned in a free-text bio. */
export function urlsInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(
    /https?:\/\/[^\s<>"')\]]+|(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*)/gi,
  )) {
    const v = (m[1] ?? m[0]).trim();
    if (v) out.add(v);
  }
  return [...out];
}

/**
 * pg_trgm-compatible trigram similarity: words are lower-cased alphanumerics padded with two
 * spaces before and one after; similarity = |A∩B| / |A∪B|. Matches the `similarity()` the
 * candidate query uses in SQL, so the "why" panel shows the number the database saw.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const words = s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}
