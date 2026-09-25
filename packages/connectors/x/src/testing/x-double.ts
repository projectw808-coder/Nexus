/**
 * A scripted double for the X (Twitter) API v2 platform: OAuth2+PKCE token/refresh/revoke
 * endpoints (accepts any code/verifier — real PKCE verification is not exercised here, matching
 * the mock platform's own OAuth double), paginated `mentions`/`dm_events` endpoints, and a DM-send
 * endpoint. State lives in this closure (not on any per-`ctx` object) so the contract suite's
 * cursor-resume test — which builds a fresh `ConnCtx` and expects to see the SAME server-side
 * state — works against one shared instance.
 */
import { jsonResponse } from '@nexus/connector-sdk/testing';
import type { FetchLike } from '@nexus/connector-sdk';

export type XDoubleMention = Record<string, unknown> & {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id?: string;
  in_reply_to_user_id?: string | null;
  deleted?: boolean;
};

export type XDoubleDmEvent = Record<string, unknown> & {
  id: string;
  event_type?: string;
  text: string;
  sender_id: string;
  dm_conversation_id: string;
  created_at: string;
  deleted?: boolean;
};

function headerLookup(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string' || !init.body) return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formBodyOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init.body === 'string' ? init.body : '');
}

export function mentionFixture(i: number, overrides: Partial<XDoubleMention> = {}): XDoubleMention {
  return {
    id: `mention_${1000 + i}`,
    text: `@test_account hello number ${i}`,
    author_id: `author_${i % 5}`,
    conversation_id: `conv_${i % 5}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    deleted: false,
    ...overrides,
  };
}

export function dmEventFixture(i: number, overrides: Partial<XDoubleDmEvent> = {}): XDoubleDmEvent {
  return {
    id: `dm_${2000 + i}`,
    event_type: 'MessageCreate',
    text: `DM number ${i}`,
    sender_id: `sender_${i % 5}`,
    dm_conversation_id: `dmconv_${i % 5}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 1, i)).toISOString(),
    deleted: false,
    ...overrides,
  };
}

export function createXDouble(
  opts: {
    totalMentions?: number;
    totalDms?: number;
    accessToken?: string;
    forceStatus?: 401 | 429;
    mentions?: XDoubleMention[];
    dms?: XDoubleDmEvent[];
    accountId?: string;
  } = {},
): {
  fetch: FetchLike;
  mentions: XDoubleMention[];
  dms: XDoubleDmEvent[];
  sentDms: {
    id: string;
    conversationId: string | null;
    recipientId: string | null;
    text: string;
  }[];
  accessToken: string;
  accountId: string;
} {
  const accessToken = opts.accessToken ?? 'test-x-access-token';
  const accountId = opts.accountId ?? 'x_user_1';
  const mentions =
    opts.mentions ?? Array.from({ length: opts.totalMentions ?? 25 }, (_, i) => mentionFixture(i));
  const dms = opts.dms ?? Array.from({ length: opts.totalDms ?? 25 }, (_, i) => dmEventFixture(i));
  const sentDms: {
    id: string;
    conversationId: string | null;
    recipientId: string | null;
    text: string;
  }[] = [];
  let dmSendCounter = 0;

  const fetch: FetchLike = async (rawUrl, init) => {
    const u = new URL(rawUrl);

    // ── OAuth endpoints: no bearer required ──
    if (u.pathname === '/oauth/token') {
      const params = formBodyOf(init);
      const grant = params.get('grant_type');
      if (grant === 'authorization_code' || grant === 'refresh_token') {
        return jsonResponse(200, {
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: 7200,
          refresh_token: 'test-x-refresh-token',
          scope: 'tweet.read tweet.write dm.read dm.write users.read offline.access',
        });
      }
      return jsonResponse(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/oauth/revoke') {
      return jsonResponse(200, {});
    }

    if (opts.forceStatus === 429)
      return jsonResponse(429, { title: 'Too Many Requests', status: 429 }, { 'retry-after': '1' });
    if (opts.forceStatus === 401) return jsonResponse(401, { title: 'Unauthorized', status: 401 });

    const token = headerLookup(init.headers, 'authorization')?.replace(/^Bearer\s+/i, '');
    if (token !== accessToken) return jsonResponse(401, { title: 'Unauthorized', status: 401 });

    if (u.pathname === '/2/users/me') {
      return jsonResponse(200, {
        data: { id: accountId, name: 'Test Account', username: 'test_account' },
      });
    }

    if (u.pathname === `/2/users/${accountId}/mentions`) {
      const maxResults = Number(u.searchParams.get('max_results') ?? '100');
      const cursor = u.searchParams.get('pagination_token');
      const startTime = u.searchParams.get('start_time');
      let rows = mentions;
      if (startTime) {
        const since = new Date(startTime);
        rows = rows.filter((m) => new Date(m.created_at) >= since);
      }
      const offset = cursor ? Number(cursor) : 0;
      const page = rows.slice(offset, offset + maxResults);
      const nextOffset = offset + maxResults;
      const next = nextOffset < rows.length ? String(nextOffset) : undefined;
      return jsonResponse(
        200,
        { data: page, meta: { result_count: page.length, next_token: next } },
        { 'x-rate-limit-limit': '450', 'x-rate-limit-remaining': '449' },
      );
    }

    if (u.pathname === '/2/dm_events') {
      const maxResults = Number(u.searchParams.get('max_results') ?? '100');
      const cursor = u.searchParams.get('pagination_token');
      const startTime = u.searchParams.get('start_time');
      let rows = dms;
      if (startTime) {
        const since = new Date(startTime);
        rows = rows.filter((d) => new Date(d.created_at) >= since);
      }
      const offset = cursor ? Number(cursor) : 0;
      const page = rows.slice(offset, offset + maxResults);
      const nextOffset = offset + maxResults;
      const next = nextOffset < rows.length ? String(nextOffset) : undefined;
      return jsonResponse(
        200,
        { data: page, meta: { result_count: page.length, next_token: next } },
        { 'x-rate-limit-limit': '15000', 'x-rate-limit-remaining': '14999' },
      );
    }

    if (u.pathname.startsWith('/2/dm_conversations/') && u.pathname.endsWith('/messages')) {
      dmSendCounter += 1;
      const id = `dm_sent_${dmSendCounter}`;
      const withMatch = /^\/2\/dm_conversations\/with\/([^/]+)\/messages$/.exec(u.pathname);
      const convMatch = /^\/2\/dm_conversations\/([^/]+)\/messages$/.exec(u.pathname);
      const recipientId = withMatch ? decodeURIComponent(withMatch[1] ?? '') : null;
      const conversationId =
        !withMatch && convMatch ? decodeURIComponent(convMatch[1] ?? '') : null;
      const text = typeof bodyOf(init).text === 'string' ? (bodyOf(init).text as string) : '';
      sentDms.push({ id, conversationId, recipientId, text });
      return jsonResponse(200, {
        data: {
          dm_event_id: id,
          dm_conversation_id: conversationId ?? recipientId ?? '',
          sent_at: new Date().toISOString(),
        },
      });
    }

    return jsonResponse(404, { title: 'Not Found', status: 404 });
  };

  return { fetch, mentions, dms, sentDms, accessToken, accountId };
}
