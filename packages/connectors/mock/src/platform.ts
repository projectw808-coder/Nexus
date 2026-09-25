/**
 * The mock platform (spec §16 Phase 4): a deterministic fake social platform served in-process
 * (as a `fetch`) or over HTTP (`listen`). Configurable latency, injected 429 / 5xx, schema
 * drift and dropped webhooks, so every pipeline guarantee can be tested without a network.
 *
 * Shape: accounts own posts, posts have comments. OAuth 2 with PKCE, bearer tokens, a real
 * fixed-window rate limit with standard headers, HMAC-signed webhooks, idempotent replies.
 */
import { createServer, type Server } from 'node:http';
import { signHmacSha256 } from '@nexus/connector-sdk';
import type { WebhookRequest } from '@nexus/connector-sdk';

export type MockFaults = {
  /** Artificial delay per request. */
  latencyMs?: number;
  /** Probability [0,1] that a data request answers 429. */
  rate429?: number;
  /** Probability [0,1] that a data request answers 503. */
  rate5xx?: number;
  /** Probability [0,1] that an item in a page is served with a mutated shape. */
  schemaDriftRate?: number;
  /** Probability [0,1] that an emitted webhook is never delivered. */
  dropWebhookRate?: number;
  retryAfterSeconds?: number;
};

export type MockPlatformOptions = {
  seed?: number;
  baseUrl?: string;
  accounts?: number;
  /** Total posts + comments across all accounts (comments are ~5× posts). */
  totalObjects?: number;
  faults?: MockFaults;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  /**
   * Suffix for ids the platform mints at run time (replies, live comments, webhook events).
   * Hosts whose instance restarts while consumers persist rows pass something unique per
   * process so a fresh instance never re-issues an id an earlier one already used.
   */
  runtimeIdSuffix?: string;
  /** Calls per 15-minute window per token. */
  rateLimit?: number;
  apiVersion?: string;
  pageSizeMax?: number;
  /** Token lifetime in seconds. */
  tokenTtlSeconds?: number;
  now?: () => number;
};

export type MockAccount = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  kind: 'page';
};
export type MockPost = {
  id: string;
  accountId: string;
  authorId: string;
  body: string;
  createdAt: string;
  mediaType: 'text' | 'image';
  likeCount: number;
  commentCount: number;
};
export type MockComment = {
  id: string;
  postId: string;
  accountId: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  body: string;
  createdAt: string;
  replyToId: string | null;
};

export type MockRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
};
export type MockResponse = { status: number; headers: Record<string, string>; body: string };

export type EmittedWebhook = { deliveryId: string; delivered: boolean; request: WebhookRequest };

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'launch',
  'update',
  'thanks',
  'question',
  'love',
  'shipping',
  'discount',
  'help',
  'broken',
  'amazing',
  'support',
  'order',
  'refund',
  'demo',
  'pricing',
];

export function createMockPlatform(opts: MockPlatformOptions = {}) {
  const seed = opts.seed ?? 42;
  const rng = prng(seed);
  const faultRng = prng(seed ^ 0x9e3779b9);
  const now = opts.now ?? (() => Date.now());
  const baseUrl = opts.baseUrl ?? 'https://mock.platform.local';
  const clientId = opts.clientId ?? 'mock-client';
  const clientSecret = opts.clientSecret ?? 'mock-secret';
  const webhookSecret = opts.webhookSecret ?? 'mock-webhook-secret';
  const idSuffix = opts.runtimeIdSuffix ?? '';
  const rateLimit = opts.rateLimit ?? 1000;
  const apiVersion = opts.apiVersion ?? '2026-09';
  const pageSizeMax = opts.pageSizeMax ?? 500;
  const tokenTtl = (opts.tokenTtlSeconds ?? 3600) * 1000;
  const faults: MockFaults = { ...opts.faults };

  // ── data ──
  const accounts: MockAccount[] = Array.from({ length: opts.accounts ?? 2 }, (_, i) => ({
    id: `acct_${i + 1}`,
    name: `Mock Account ${i + 1}`,
    handle: `mock${i + 1}`,
    avatarUrl: `${baseUrl}/avatars/acct_${i + 1}.png`,
    kind: 'page',
  }));
  const total = opts.totalObjects ?? 600;
  const postCount = Math.max(1, Math.floor(total / 6));
  const posts: MockPost[] = [];
  const comments: MockComment[] = [];
  // Objects are spread over the 60 days before `now` (newest last) so a default 90-day backfill sees all of them.
  const spanMs = 60 * 86_400_000;
  const start = now() - spanMs;
  const stepMs = Math.max(1, Math.floor(spanMs / Math.max(1, postCount)));
  let seq = 0;
  const sentence = () =>
    Array.from(
      { length: 4 + Math.floor(rng() * 8) },
      () => WORDS[Math.floor(rng() * WORDS.length)],
    ).join(' ');
  for (let i = 0; i < postCount; i++) {
    const account = accounts[i % accounts.length]!;
    posts.push({
      id: `post_${++seq}`,
      accountId: account.id,
      authorId: account.id,
      body: `Post ${i + 1}: ${sentence()}`,
      createdAt: new Date(start + i * stepMs).toISOString(),
      mediaType: rng() < 0.3 ? 'image' : 'text',
      likeCount: Math.floor(rng() * 500),
      commentCount: 0,
    });
  }
  let remaining = total - postCount;
  let ci = 0;
  while (remaining > 0) {
    const post = posts[ci % posts.length]!;
    const userN = 1 + Math.floor(rng() * 400);
    comments.push({
      id: `comment_${++seq}`,
      postId: post.id,
      accountId: post.accountId,
      authorId: `user_${userN}`,
      authorName: `User ${userN}`,
      authorHandle: `user${userN}`,
      body: sentence(),
      createdAt: new Date(
        Math.min(
          now() - 1_000,
          Date.parse(post.createdAt) + 1_000 * (1 + (ci % Math.max(1, Math.floor(stepMs / 1_000)))),
        ),
      ).toISOString(),
      replyToId: null,
    });
    post.commentCount += 1;
    ci += 1;
    remaining -= 1;
  }
  const commentsById = new Map(comments.map((c) => [c.id, c]));

  // ── auth ──
  type Token = { accountIds: string[]; scopes: string[]; expiresAt: number; refreshToken: string };
  const tokens = new Map<string, Token>();
  const refreshTokens = new Map<string, string>(); // refresh → access
  const revoked = new Set<string>();
  let tokenSeq = 0;
  const issue = (
    scopes: string[],
  ): { accessToken: string; refreshToken: string; expiresIn: number } => {
    const accessToken = `mock_at_${++tokenSeq}_${Math.floor(rng() * 1e9).toString(36)}`;
    const refreshToken = `mock_rt_${tokenSeq}_${Math.floor(rng() * 1e9).toString(36)}`;
    tokens.set(accessToken, {
      accountIds: accounts.map((a) => a.id),
      scopes,
      expiresAt: now() + tokenTtl,
      refreshToken,
    });
    refreshTokens.set(refreshToken, accessToken);
    return { accessToken, refreshToken, expiresIn: tokenTtl / 1000 };
  };

  // ── rate limit (fixed 15-minute window per token) ──
  const windows = new Map<string, { start: number; count: number }>();
  const WINDOW_MS = 15 * 60_000;
  const rateHeaders = (token: string): { headers: Record<string, string>; exceeded: boolean } => {
    const ws = Math.floor(now() / WINDOW_MS) * WINDOW_MS;
    const w = windows.get(token);
    const cur = w && w.start === ws ? w : { start: ws, count: 0 };
    cur.count += 1;
    windows.set(token, cur);
    const remainingCalls = Math.max(0, rateLimit - cur.count);
    return {
      headers: {
        'x-ratelimit-limit': String(rateLimit),
        'x-ratelimit-remaining': String(remainingCalls),
        'x-ratelimit-reset': String(Math.floor((ws + WINDOW_MS) / 1000)),
      },
      exceeded: cur.count > rateLimit,
    };
  };

  // ── stats ──
  const stats = {
    requests: 0,
    ok: 0,
    r401: 0,
    r429: 0,
    r5xx: 0,
    driftInjected: 0,
    webhooksEmitted: 0,
    webhooksDropped: 0,
    replies: 0,
  };

  // ── replies / idempotency ──
  const idempotency = new Map<string, MockComment>();
  const subscriptions = new Set<string>();
  /** Per-account signing secrets registered on subscribe; falls back to the platform default. */
  const accountSecrets = new Map<string, string>();

  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): MockResponse => ({
    status,
    headers: { 'content-type': 'application/json', 'x-mock-api-version': apiVersion, ...headers },
    body: JSON.stringify(body),
  });

  function drift<T extends object>(item: T): T | Record<string, unknown> {
    if (!faults.schemaDriftRate || faultRng() >= faults.schemaDriftRate) return item;
    stats.driftInjected += 1;
    const { body: _b, ...rest } = item as T & { body?: string };
    // Renamed field + a timestamp in a format nobody agreed on.
    return { ...rest, content: (item as { body?: string }).body, createdAt: 'yesterday' };
  }

  function page<T extends { id: string; createdAt: string }>(
    all: T[],
    q: Record<string, string>,
  ): { items: T[]; nextCursor: string | null } {
    const limit = Math.min(pageSizeMax, Math.max(1, Number(q.limit ?? 100) || 100));
    const since = q.since ? Date.parse(q.since) : null;
    const filtered =
      since === null || Number.isNaN(since)
        ? all
        : all.filter((x) => Date.parse(x.createdAt) >= since);
    const offset = q.cursor
      ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8').replace('o:', '')) || 0
      : 0;
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      items,
      nextCursor:
        nextOffset < filtered.length ? Buffer.from(`o:${nextOffset}`).toString('base64url') : null,
    };
  }

  function authed(req: MockRequest): { token: string; t: Token } | MockResponse {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const t = tokens.get(token);
    if (!t || revoked.has(token) || t.expiresAt <= now()) {
      stats.r401 += 1;
      return json(401, {
        error: { code: 'invalid_token', message: 'The access token is invalid or has expired.' },
      });
    }
    return { token, t };
  }

  async function handle(req: MockRequest): Promise<MockResponse> {
    stats.requests += 1;
    if (faults.latencyMs) await new Promise((r) => setTimeout(r, faults.latencyMs));
    const path = req.path.replace(/\/+$/, '') || '/';
    const form = () => Object.fromEntries(new URLSearchParams(req.body));

    // ── OAuth ──
    if (req.method === 'POST' && path === '/oauth/token') {
      const f = form();
      if (f.client_id !== clientId || f.client_secret !== clientSecret)
        return json(401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        if (!f.code || !f.code.startsWith('code-') || !f.code_verifier)
          return json(400, {
            error: 'invalid_grant',
            error_description: 'unknown code or missing verifier',
          });
        const scopes = (
          f.code.split('scope=')[1] ?? 'read:posts read:comments write:reply_comment'
        ).split(' ');
        const t = issue(scopes);
        return json(200, {
          access_token: t.accessToken,
          refresh_token: t.refreshToken,
          expires_in: t.expiresIn,
          token_type: 'bearer',
          scope: scopes.join(' '),
        });
      }
      if (f.grant_type === 'refresh_token') {
        const access = f.refresh_token ? refreshTokens.get(f.refresh_token) : undefined;
        const prev = access ? tokens.get(access) : undefined;
        if (!prev || (access && revoked.has(access)))
          return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        const t = issue(prev.scopes);
        if (access) tokens.delete(access);
        return json(200, {
          access_token: t.accessToken,
          refresh_token: t.refreshToken,
          expires_in: t.expiresIn,
          token_type: 'bearer',
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && path === '/oauth/revoke') {
      const f = form();
      if (f.token) {
        revoked.add(f.token);
        const via = refreshTokens.get(f.token);
        if (via) revoked.add(via);
      }
      return json(200, {});
    }
    if (req.method === 'GET' && path === '/v1/health')
      return json(200, { status: 'ok', apiVersion });

    // ── authenticated ──
    const a = authed(req);
    if ('status' in a) return a;
    const rl = rateHeaders(a.token);
    if (rl.exceeded) {
      stats.r429 += 1;
      return json(
        429,
        { error: { code: 'rate_limited' } },
        { ...rl.headers, 'retry-after': String(faults.retryAfterSeconds ?? 1) },
      );
    }
    if (faults.rate429 && faultRng() < faults.rate429) {
      stats.r429 += 1;
      return json(
        429,
        { error: { code: 'rate_limited', injected: true } },
        { ...rl.headers, 'retry-after': String(faults.retryAfterSeconds ?? 0) },
      );
    }
    if (faults.rate5xx && faultRng() < faults.rate5xx) {
      stats.r5xx += 1;
      return json(503, { error: { code: 'unavailable', injected: true } }, rl.headers);
    }

    if (req.method === 'GET' && path === '/v1/me') {
      stats.ok += 1;
      return json(200, { id: 'user_me', name: 'Mock User', scopes: a.t.scopes }, rl.headers);
    }
    if (req.method === 'GET' && path === '/v1/accounts') {
      stats.ok += 1;
      return json(200, { data: accounts.filter((x) => a.t.accountIds.includes(x.id)) }, rl.headers);
    }
    const m = /^\/v1\/accounts\/([^/]+)\/(posts|comments)$/.exec(path);
    if (req.method === 'GET' && m) {
      const accountId = m[1]!;
      if (!a.t.accountIds.includes(accountId))
        return json(403, { error: { code: 'forbidden' } }, rl.headers);
      stats.ok += 1;
      if (m[2] === 'posts') {
        const p = page(
          posts.filter((x) => x.accountId === accountId),
          req.query,
        );
        return json(
          200,
          { data: p.items.map((x) => drift(x)), paging: { next: p.nextCursor } },
          rl.headers,
        );
      }
      const p = page(
        comments.filter((x) => x.accountId === accountId),
        req.query,
      );
      return json(
        200,
        { data: p.items.map((x) => drift(x)), paging: { next: p.nextCursor } },
        rl.headers,
      );
    }
    const r = /^\/v1\/comments\/([^/]+)\/replies$/.exec(path);
    if (req.method === 'POST' && r) {
      if (!a.t.scopes.includes('write:reply_comment'))
        return json(403, { error: { code: 'insufficient_scope' } }, rl.headers);
      const parent = commentsById.get(r[1]!);
      if (!parent) return json(404, { error: { code: 'not_found' } }, rl.headers);
      const key = req.headers['idempotency-key'];
      if (key && idempotency.has(key))
        return json(200, { data: idempotency.get(key), replayed: true }, rl.headers);
      const body = (JSON.parse(req.body || '{}') as { text?: string }).text ?? '';
      if (!body.trim()) return json(422, { error: { code: 'empty_body' } }, rl.headers);
      const reply: MockComment = {
        id: `comment_${++seq}${idSuffix}`,
        postId: parent.postId,
        accountId: parent.accountId,
        authorId: parent.accountId,
        authorName: 'Mock Account',
        authorHandle: 'mock',
        body,
        createdAt: new Date(now()).toISOString(),
        replyToId: parent.id,
      };
      comments.push(reply);
      commentsById.set(reply.id, reply);
      if (key) idempotency.set(key, reply);
      stats.replies += 1;
      stats.ok += 1;
      return json(201, { data: reply }, rl.headers);
    }
    if (req.method === 'POST' && path === '/v1/webhooks/subscribe') {
      const b = JSON.parse(req.body || '{}') as {
        resources?: string[];
        accountId?: string;
        secret?: string | null;
      };
      for (const res of b.resources ?? []) subscriptions.add(res);
      if (b.accountId && b.secret) accountSecrets.set(b.accountId, b.secret);
      stats.ok += 1;
      return json(200, { subscribed: [...subscriptions] }, rl.headers);
    }
    return json(404, { error: { code: 'not_found', path } }, rl.headers);
  }

  // ── fetch adapter (in-process) ──
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== new URL(baseUrl).origin)
      return new Response('not the mock platform', { status: 502 });
    const headers: Record<string, string> = {};
    const h = init.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
    else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body).toString('utf8')
          : '';
    const res = await handle({
      method: (init.method ?? 'GET').toUpperCase(),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };

  // ── webhooks ──
  let deliverer: ((req: WebhookRequest) => unknown) | null = null;
  const emitted: EmittedWebhook[] = [];
  let deliverySeq = 0;
  function sign(body: string, accountId: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-mock-signature': signHmacSha256(body, accountSecrets.get(accountId) ?? webhookSecret),
      'x-mock-delivery': `d_${++deliverySeq}`,
    };
  }
  async function emit(
    event: 'post.created' | 'comment.created',
    data: MockPost | MockComment,
    path = '/api/webhooks/mock',
  ): Promise<EmittedWebhook> {
    stats.webhooksEmitted += 1;
    const body = JSON.stringify({
      id: `evt_${deliverySeq + 1}${idSuffix}`,
      event,
      accountId: data.accountId,
      data,
      sentAt: new Date(now()).toISOString(),
    });
    const headers = sign(body, data.accountId);
    const request: WebhookRequest = {
      method: 'POST',
      path,
      headers,
      rawBody: Buffer.from(body, 'utf8'),
      query: {},
    };
    const dropped = Boolean(faults.dropWebhookRate) && faultRng() < (faults.dropWebhookRate ?? 0);
    const record: EmittedWebhook = {
      deliveryId: headers['x-mock-delivery']!,
      delivered: !dropped,
      request,
    };
    emitted.push(record);
    if (dropped) stats.webhooksDropped += 1;
    else if (deliverer) await deliverer(request);
    return record;
  }

  /** Simulate live activity: a new inbound comment on a random post of `accountId`, announced by webhook. */
  async function newComment(
    accountId: string,
    body?: string,
    path?: string,
    /** Explicit id, for hosts whose in-memory instance restarts while its consumers persist rows. */
    id?: string,
  ): Promise<{ comment: MockComment; webhook: EmittedWebhook }> {
    const candidates = posts.filter((p) => p.accountId === accountId);
    const post = candidates[Math.floor(rng() * candidates.length)]!;
    const userN = 1 + Math.floor(rng() * 400);
    const comment: MockComment = {
      id: id ?? `comment_${++seq}${idSuffix}`,
      postId: post.id,
      accountId,
      authorId: `user_${userN}`,
      authorName: `User ${userN}`,
      authorHandle: `user${userN}`,
      body: body ?? sentence(),
      createdAt: new Date(now()).toISOString(),
      replyToId: null,
    };
    comments.push(comment);
    commentsById.set(comment.id, comment);
    post.commentCount += 1;
    const webhook = await emit('comment.created', comment, path);
    return { comment, webhook };
  }

  // ── HTTP server (for e2e / the seed) ──
  let server: Server | null = null;
  async function listen(port = 0): Promise<{ port: number; url: string }> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://localhost');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers))
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
        void handle({
          method: (req.method ?? 'GET').toUpperCase(),
          path: u.pathname,
          query: Object.fromEntries(u.searchParams),
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }).then((r) => {
          res.writeHead(r.status, r.headers);
          res.end(r.body);
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(port, resolve));
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    return { port: p, url: `http://127.0.0.1:${p}` };
  }
  async function close(): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    webhookSecret,
    apiVersion,
    accounts,
    posts,
    comments,
    stats,
    faults,
    fetch: fetchImpl,
    handle,
    listen,
    close,
    /** Register where emitted webhooks go (the receiver under test). */
    onWebhook(fn: (req: WebhookRequest) => unknown) {
      deliverer = fn;
    },
    emit,
    emitted,
    newComment,
    /** A pre-issued token, for contexts that skip the OAuth dance. */
    issueToken(scopes = ['read:posts', 'read:comments', 'write:reply_comment']) {
      return issue(scopes);
    },
    /** Make a token unusable, simulating platform-side revocation. */
    revokeToken(token: string) {
      revoked.add(token);
    },
    subscriptions,
    setFaults(next: MockFaults) {
      Object.assign(faults, next);
    },
  };
}

export type MockPlatform = ReturnType<typeof createMockPlatform>;
