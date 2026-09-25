/**
 * OAuth 2.0 helpers (spec §16 Phase 4: code + PKCE + refresh). Connectors compose these in
 * `buildAuthUrl` / `exchangeCode` / `refresh` / `revoke`; core mints PKCE pairs and the signed
 * `state`. Nothing here logs or persists a token — results go straight to the vault.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import { tokenSetSchema, type HttpClient, type PkcePair, type TokenSet } from '../spi.ts';

const b64url = (b: Buffer): string => b.toString('base64url');

// ─── PKCE ───────────────────────────────────────────────────────────────────

/** RFC 7636: a 43–128 char verifier and its S256 challenge. */
export function generatePkcePair(): PkcePair {
  const verifier = b64url(randomBytes(48)); // 64 chars
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

// ─── Signed state (CSRF token that also carries the flow context) ───────────

export const oauthStatePayloadSchema = z.object({
  workspaceId: z.string().min(1),
  platform: z.string().min(1),
  userId: z.string().min(1),
  /** Where to send the browser after the callback. Relative paths only. */
  returnTo: z.string().startsWith('/').default('/'),
  /** Re-authorisation of an existing connection. */
  connectionId: z.string().optional(),
  nonce: z.string().min(8),
  issuedAt: z.number().int(),
});
export type OauthStatePayload = z.infer<typeof oauthStatePayloadSchema>;

function sign(secret: string, body: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

/** `base64url(json) . base64url(hmac)`. The signature makes the state unforgeable; the nonce makes it single-use once core records it. */
export function mintOauthState(
  secret: string,
  payload: Omit<OauthStatePayload, 'nonce' | 'issuedAt'> & { nonce?: string; issuedAt?: number },
): string {
  const full: OauthStatePayload = oauthStatePayloadSchema.parse({
    ...payload,
    nonce: payload.nonce ?? b64url(randomBytes(12)),
    issuedAt: payload.issuedAt ?? Date.now(),
  });
  const body = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${body}.${sign(secret, body)}`;
}

export function verifyOauthState(
  secret: string,
  state: string,
  opts: { maxAgeMs?: number; now?: () => number } = {},
): OauthStatePayload {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new NexusError('VALIDATION', { message: 'malformed OAuth state' });
  const expected = sign(secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new NexusError('VALIDATION', { message: 'OAuth state signature mismatch' });
  }
  const parsed = oauthStatePayloadSchema.safeParse(
    JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
  );
  if (!parsed.success)
    throw new NexusError('VALIDATION', { message: 'OAuth state payload invalid' });
  const now = opts.now?.() ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  if (now - parsed.data.issuedAt > maxAge) {
    throw new NexusError('VALIDATION', {
      message: 'OAuth state expired — start the connection again',
    });
  }
  return parsed.data;
}

// ─── Authorization URL ──────────────────────────────────────────────────────

export function buildAuthorizationUrl(opts: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  pkce?: PkcePair;
  /** Platform-specific extras (`access_type=offline`, `prompt=consent`, `response_mode`). */
  extraParams?: Record<string, string>;
  scopeSeparator?: string;
}): string {
  const url = new URL(opts.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  if (opts.scopes.length)
    url.searchParams.set('scope', opts.scopes.join(opts.scopeSeparator ?? ' '));
  url.searchParams.set('state', opts.state);
  if (opts.pkce) {
    url.searchParams.set('code_challenge', opts.pkce.challenge);
    url.searchParams.set('code_challenge_method', opts.pkce.method);
  }
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

// ─── Token endpoint ─────────────────────────────────────────────────────────

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().optional(),
  refresh_token: z.string().optional(),
  /** Space- or comma-separated depending on the platform. */
  scope: z.string().optional(),
});

const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** Turn a standard token response into a `TokenSet`; carries the previous refresh token forward when the platform does not rotate it. */
export function parseTokenResponse(
  json: unknown,
  opts: { now?: Date; previous?: TokenSet; requestedScopes?: string[] } = {},
): TokenSet {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new NexusError('SCHEMA_DRIFT', {
      message: 'token endpoint returned an unexpected shape',
      details: { issues: parsed.error.issues.map((i) => i.message) },
    });
  }
  const t = parsed.data;
  const now = opts.now ?? new Date();
  const scopes = t.scope
    ? t.scope.split(/[\s,]+/).filter(Boolean)
    : (opts.previous?.scopes ?? opts.requestedScopes ?? []);
  return tokenSetSchema.parse({
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? opts.previous?.refreshToken,
    expiresAt:
      t.expires_in !== undefined ? new Date(now.getTime() + t.expires_in * 1000) : undefined,
    scopes,
    tokenType: t.token_type ?? 'Bearer',
    raw: json,
  });
}

/** Map an OAuth error body onto the taxonomy: `invalid_grant` is an expired/revoked grant. */
export function classifyOauthError(status: number, body: unknown): NexusError {
  const e = oauthErrorSchema.safeParse(body);
  const code = e.success ? e.data.error : undefined;
  const description = e.success ? e.data.error_description : undefined;
  if (code === 'invalid_grant' || status === 401) {
    return new NexusError('AUTH_EXPIRED', {
      message: description ?? 'the authorization grant is no longer valid',
      details: { oauthError: code, status },
    });
  }
  if (code === 'invalid_scope' || code === 'insufficient_scope' || status === 403) {
    return new NexusError('SCOPE_MISSING', {
      message: description ?? 'the platform refused the requested scopes',
      details: { oauthError: code, status },
    });
  }
  if (status === 429) return new NexusError('RATE_LIMITED', { details: { status } });
  if (status >= 500) return new NexusError('PLATFORM_DOWN', { details: { status } });
  return new NexusError('VALIDATION', {
    message: description ?? `token endpoint rejected the request (${code ?? status})`,
    details: { oauthError: code, status },
  });
}

type ClientAuth = 'body' | 'basic';

function formBody(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  return p.toString();
}

function authHeaders(
  auth: ClientAuth,
  clientId: string,
  clientSecret?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (auth === 'basic' && clientSecret !== undefined) {
    h.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  return h;
}

/** The HTTP client throws on 4xx; re-read the OAuth error body it captured so `invalid_grant` etc. classify correctly. */
function rethrowClassified(e: unknown): never {
  if (e instanceof NexusError && typeof e.details.status === 'number') {
    let body: unknown = null;
    try {
      body = typeof e.details.bodyText === 'string' ? JSON.parse(e.details.bodyText) : null;
    } catch {
      body = null;
    }
    throw classifyOauthError(e.details.status, body);
  }
  throw e;
}

async function postToken(
  http: HttpClient,
  url: string,
  headers: Record<string, string>,
  body: string,
  endpoint: string,
): Promise<unknown> {
  const res = await http
    .request({ method: 'POST', url, headers, body, endpoint })
    .catch(rethrowClassified);
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = { error: 'invalid_response', error_description: res.bodyText.slice(0, 200) };
  }
  if (res.status >= 400) throw classifyOauthError(res.status, json);
  return json;
}

export async function exchangeAuthorizationCode(
  http: HttpClient,
  opts: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    verifier?: string;
    auth?: ClientAuth;
    extraParams?: Record<string, string>;
    requestedScopes?: string[];
  },
): Promise<TokenSet> {
  const auth = opts.auth ?? 'body';
  const json = await postToken(
    http,
    opts.tokenUrl,
    authHeaders(auth, opts.clientId, opts.clientSecret),
    formBody({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: auth === 'body' ? opts.clientSecret : undefined,
      code_verifier: opts.verifier,
      ...opts.extraParams,
    }),
    'oauth.token',
  );
  return parseTokenResponse(json, { requestedScopes: opts.requestedScopes });
}

export async function refreshAccessToken(
  http: HttpClient,
  opts: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    token: TokenSet;
    auth?: ClientAuth;
    extraParams?: Record<string, string>;
  },
): Promise<TokenSet> {
  if (!opts.token.refreshToken) {
    throw new NexusError('AUTH_EXPIRED', {
      message: 'no refresh token on file — the user must re-authorize',
    });
  }
  const auth = opts.auth ?? 'body';
  const json = await postToken(
    http,
    opts.tokenUrl,
    authHeaders(auth, opts.clientId, opts.clientSecret),
    formBody({
      grant_type: 'refresh_token',
      refresh_token: opts.token.refreshToken,
      client_id: opts.clientId,
      client_secret: auth === 'body' ? opts.clientSecret : undefined,
      ...opts.extraParams,
    }),
    'oauth.refresh',
  );
  return parseTokenResponse(json, { previous: opts.token });
}

/** RFC 7009 revocation. Best-effort by contract: 2xx and 404 both count as revoked. */
export async function revokeToken(
  http: HttpClient,
  opts: {
    revokeUrl: string;
    clientId: string;
    clientSecret?: string;
    token: string;
    tokenTypeHint?: 'access_token' | 'refresh_token';
    auth?: ClientAuth;
  },
): Promise<void> {
  const auth = opts.auth ?? 'body';
  const res = await http
    .request({
      method: 'POST',
      url: opts.revokeUrl,
      headers: authHeaders(auth, opts.clientId, opts.clientSecret),
      body: formBody({
        token: opts.token,
        token_type_hint: opts.tokenTypeHint,
        client_id: opts.clientId,
        client_secret: auth === 'body' ? opts.clientSecret : undefined,
      }),
      endpoint: 'oauth.revoke',
    })
    .catch((e: unknown) => {
      if (e instanceof NexusError && e.code === 'NOT_FOUND')
        return { status: 404, headers: {}, bodyText: '', json: () => null };
      return rethrowClassified(e);
    });
  if (res.status >= 400 && res.status !== 404) {
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      /* non-JSON error body */
    }
    throw classifyOauthError(res.status, json);
  }
}

// ─── Lifecycle (§5.4) ───────────────────────────────────────────────────────

export const REFRESH_AT_FRACTION = 0.7;
export const RECONNECT_WARNING_MS = 7 * 24 * 3600_000;

export type TokenLifecycle =
  | { state: 'fresh'; refreshAt: Date | null }
  | { state: 'refresh_due'; refreshAt: Date }
  | { state: 'reconnect_soon'; expiresAt: Date }
  | { state: 'expired'; expiresAt: Date }
  | { state: 'no_expiry' };

/**
 * Where a token is in its life. `issuedAt` is when the current access token was obtained
 * (the vault's `rotatedAt`); refresh is due at 70% of the remaining lifetime measured from it.
 * A token with no refresh path within 7 days of expiry is `reconnect_soon` — core raises the
 * banner, emails the owner and pauses the connection.
 */
export function tokenLifecycle(
  token: Pick<TokenSet, 'expiresAt' | 'refreshToken'>,
  opts: { issuedAt: Date; now?: Date; refreshable?: boolean },
): TokenLifecycle {
  const now = opts.now ?? new Date();
  if (!token.expiresAt) return { state: 'no_expiry' };
  const expiresAt = token.expiresAt;
  if (expiresAt.getTime() <= now.getTime()) return { state: 'expired', expiresAt };
  const refreshable = opts.refreshable ?? Boolean(token.refreshToken);
  if (!refreshable) {
    return expiresAt.getTime() - now.getTime() <= RECONNECT_WARNING_MS
      ? { state: 'reconnect_soon', expiresAt }
      : { state: 'fresh', refreshAt: null };
  }
  const lifetime = expiresAt.getTime() - opts.issuedAt.getTime();
  const refreshAt = new Date(opts.issuedAt.getTime() + Math.floor(lifetime * REFRESH_AT_FRACTION));
  return now.getTime() >= refreshAt.getTime()
    ? { state: 'refresh_due', refreshAt }
    : { state: 'fresh', refreshAt };
}
