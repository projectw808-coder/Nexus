/**
 * Webhook verification primitives (spec §5.4). All comparisons are constant-time and computed
 * over the raw request bytes — never over a re-serialised body. Connectors call these from
 * `verifyWebhook`, which sits on the < 200 ms ack path, so everything here is synchronous.
 */
import { createHmac, createVerify, timingSafeEqual, type JsonWebKey } from 'node:crypto';

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const toBuffer = (body: Uint8Array | string): Buffer =>
  typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);

/**
 * `HMAC-SHA256(secret, rawBody)` compared with a signature header such as Meta's
 * `X-Hub-Signature-256: sha256=<hex>`.
 */
export function verifyHmacSha256(opts: {
  rawBody: Uint8Array | string;
  secret: string;
  signature: string | undefined;
  /** Prefix stripped from the header value (`sha256=`). */
  prefix?: string;
  encoding?: 'hex' | 'base64';
}): boolean {
  if (!opts.signature || !opts.secret) return false;
  const prefix = opts.prefix ?? 'sha256=';
  const provided = opts.signature.startsWith(prefix)
    ? opts.signature.slice(prefix.length)
    : opts.signature;
  const encoding = opts.encoding ?? 'hex';
  const expected = createHmac('sha256', opts.secret)
    .update(toBuffer(opts.rawBody))
    .digest(encoding);
  return safeEqual(Buffer.from(provided, encoding), Buffer.from(expected, encoding));
}

/** Compute the header value a platform (or the mock) would send. */
export function signHmacSha256(
  rawBody: Uint8Array | string,
  secret: string,
  opts: { prefix?: string; encoding?: 'hex' | 'base64' } = {},
): string {
  const digest = createHmac('sha256', secret)
    .update(toBuffer(rawBody))
    .digest(opts.encoding ?? 'hex');
  return `${opts.prefix ?? 'sha256='}${digest}`;
}

/** A shared secret carried in a header, query string or path segment (Keitaro, TikTok verification token). */
export function verifySharedSecret(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return safeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

// ─── JWT (Google Pub/Sub push uses RS256 with Google's public certificates) ──

export type Jwk = JsonWebKey & { kid?: string; alg?: string };

export type JwtClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  [k: string]: unknown;
};

function b64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verify an RS256 JWT against a JWKS the caller supplies (core fetches and caches Google's
 * keys). Returns the claims or `null`; never throws on a bad token so the ack path stays simple.
 */
export function verifyJwtRs256(
  token: string | undefined,
  opts: {
    jwks: { keys: Jwk[] };
    audience?: string;
    issuer?: string | string[];
    now?: () => number;
    leewaySeconds?: number;
  },
): JwtClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = b64urlJson(h) as { alg?: string; kid?: string };
    claims = b64urlJson(p) as JwtClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  const candidates = opts.jwks.keys.filter((k) => !header.kid || k.kid === header.kid);
  const verified = candidates.some((jwk) => {
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${h}.${p}`);
      return verifier.verify({ key: jwk, format: 'jwk' }, Buffer.from(s, 'base64url'));
    } catch {
      return false;
    }
  });
  if (!verified) return null;
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const leeway = opts.leewaySeconds ?? 60;
  if (typeof claims.exp === 'number' && now > claims.exp + leeway) return null;
  if (typeof claims.nbf === 'number' && now + leeway < claims.nbf) return null;
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(opts.audience)) return null;
  }
  if (opts.issuer) {
    const issuers = Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer];
    if (!claims.iss || !issuers.includes(claims.iss)) return null;
  }
  return claims;
}
