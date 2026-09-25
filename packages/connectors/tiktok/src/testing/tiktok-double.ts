/**
 * A scripted double for the TikTok for Business / Display APIs: OAuth2 token/refresh/revoke,
 * paginated videos/comments/DMs/leads endpoints, outbound send/reply/manage endpoints, and
 * HMAC-signed webhook payload builders. State (arrays, sent-message idempotency ledger) is
 * closed over by `fetch`, shared across every `ConnCtx` built against the same double instance —
 * the contract suite's cursor-resume test relies on this, same as `@nexus/connector-keitaro`'s
 * double.
 */
import { jsonResponse } from '@nexus/connector-sdk/testing';
import { signHmacSha256, type FetchLike } from '@nexus/connector-sdk';

export type TikTokDoubleVideo = {
  id: string;
  create_time: number;
  video_description: string;
  cover_image_url: string | null;
  share_url: string | null;
  duration: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
};

export type TikTokDoubleComment = {
  comment_id: string;
  video_id: string;
  text: string;
  create_time: number;
  user: { open_id: string; display_name: string; avatar_url: string | null };
  parent_comment_id: string | null;
  like_count: number;
};

export type TikTokDoubleDm = {
  message_id: string;
  conversation_id: string;
  from_user_id: string;
  to_user_id: string;
  content: { text: string };
  create_time: number;
  is_from_customer: boolean;
};

export type TikTokDoubleLead = {
  lead_id: string;
  form_id: string;
  form_name: string | null;
  create_time: number;
  ad_id: string | null;
  campaign_id: string | null;
  field_data: { name: string; value: string }[];
};

const BIZ_ACCOUNT_ID = 'biz_acct_1';

export function videoFixture(
  i: number,
  overrides: Partial<TikTokDoubleVideo> = {},
): TikTokDoubleVideo {
  return {
    id: `video_${i}`,
    create_time: Math.floor(Date.UTC(2026, 8, 1, 0, i) / 1000),
    video_description: `Behind the scenes #${i}`,
    cover_image_url: `https://p16.tiktokcdn.example/cover_${i}.jpg`,
    share_url: `https://www.tiktok.com/@acme/video/${1000 + i}`,
    duration: 15 + i,
    view_count: 1000 * (i + 1),
    like_count: 100 * (i + 1),
    comment_count: 10 * (i + 1),
    share_count: i,
    ...overrides,
  };
}

export function commentFixture(
  i: number,
  overrides: Partial<TikTokDoubleComment> = {},
): TikTokDoubleComment {
  return {
    comment_id: `comment_${i}`,
    video_id: `video_${i % 3}`,
    text: `Nice video! #${i}`,
    create_time: Math.floor(Date.UTC(2026, 8, 2, 0, i) / 1000),
    user: {
      open_id: `fan_${i}`,
      display_name: `Fan ${i}`,
      avatar_url: `https://p16.tiktokcdn.example/fan_${i}.jpg`,
    },
    parent_comment_id: null,
    like_count: i,
    ...overrides,
  };
}

export function dmFixture(i: number, overrides: Partial<TikTokDoubleDm> = {}): TikTokDoubleDm {
  const customer = `customer_${i}`;
  return {
    message_id: `msg_${i}`,
    conversation_id: `conv_${customer}`,
    from_user_id: customer,
    to_user_id: BIZ_ACCOUNT_ID,
    content: { text: `Hi, question #${i}` },
    create_time: Math.floor(Date.UTC(2026, 8, 3, 0, i) / 1000),
    is_from_customer: true,
    ...overrides,
  };
}

export function leadFixture(
  i: number,
  overrides: Partial<TikTokDoubleLead> = {},
): TikTokDoubleLead {
  return {
    lead_id: `lead_${i}`,
    form_id: 'form_1',
    form_name: 'Free Trial Signup',
    create_time: Math.floor(Date.UTC(2026, 8, 4, 0, i) / 1000),
    ad_id: `ad_${i}`,
    campaign_id: 'campaign_1',
    field_data: [
      { name: 'full_name', value: `Lead Person ${i}` },
      { name: 'email', value: `lead${i}@example.com` },
      { name: 'phone_number', value: '+15550001234' },
    ],
    ...overrides,
  };
}

function headerLookup(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function signTikTokWebhook(body: string, secret: string): string {
  return signHmacSha256(body, secret, { prefix: 'sha256=' });
}

export function tiktokWebhookRequest(opts: {
  path: string;
  event: 'message.receive' | 'lead.submit';
  content: unknown;
  secret: string;
  createTime?: number;
}): {
  path: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  query: Record<string, string>;
} {
  const body = JSON.stringify({
    event: opts.event,
    create_time: opts.createTime ?? Math.floor(Date.now() / 1000),
    content: opts.content,
  });
  return {
    method: 'POST',
    path: opts.path,
    headers: {
      'x-tiktok-signature': signTikTokWebhook(body, opts.secret),
      'content-type': 'application/json',
    },
    rawBody: body,
    query: {},
  };
}

export function createTikTokDouble(
  opts: {
    totalVideos?: number;
    totalComments?: number;
    totalDms?: number;
    totalLeads?: number;
    pageSize?: number;
    accessToken?: string;
    refreshToken?: string;
    scopes?: string[];
    webhookSecret?: string;
    forceStatus?: 401 | 429;
    videos?: TikTokDoubleVideo[];
    comments?: TikTokDoubleComment[];
    dms?: TikTokDoubleDm[];
    leads?: TikTokDoubleLead[];
  } = {},
): {
  fetch: FetchLike;
  videos: TikTokDoubleVideo[];
  comments: TikTokDoubleComment[];
  dms: TikTokDoubleDm[];
  leads: TikTokDoubleLead[];
  accessToken: string;
  refreshToken: string;
  webhookSecret: string;
  businessAccountId: string;
  sentMessages: Map<string, string>;
  stats: { sends: number; commentActions: number; refreshes: number };
} {
  const accessToken = opts.accessToken ?? 'test-tiktok-access-token';
  const refreshToken = opts.refreshToken ?? 'test-tiktok-refresh-token';
  const scopes = opts.scopes ?? [
    'user.info.basic',
    'video.list',
    'video.comment.list',
    'video.comment.manage',
    'biz.dm.read',
    'biz.dm.send',
    'leads.retrieval',
  ];
  const webhookSecret = opts.webhookSecret ?? 'test-webhook-secret';
  const pageSize = opts.pageSize ?? 5;

  const videos =
    opts.videos ?? Array.from({ length: opts.totalVideos ?? 12 }, (_, i) => videoFixture(i));
  const comments =
    opts.comments ?? Array.from({ length: opts.totalComments ?? 12 }, (_, i) => commentFixture(i));
  const dms = opts.dms ?? Array.from({ length: opts.totalDms ?? 12 }, (_, i) => dmFixture(i));
  const leads =
    opts.leads ?? Array.from({ length: opts.totalLeads ?? 12 }, (_, i) => leadFixture(i));

  const sentMessages = new Map<string, string>();
  const commentActions = new Map<string, string>();
  const stats = { sends: 0, commentActions: 0, refreshes: 0 };
  let sendCounter = 0;
  let commentActionCounter = 0;

  function page<T>(
    items: T[],
    offset: number,
    limit: number,
  ): { slice: T[]; cursor: number; has_more: boolean } {
    const slice = items.slice(offset, offset + limit);
    const cursor = offset + slice.length;
    return { slice, cursor, has_more: cursor < items.length };
  }

  const fetch: FetchLike = async (rawUrl, init) => {
    if (opts.forceStatus === 429)
      return jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '1' });
    if (opts.forceStatus === 401)
      return jsonResponse(401, { error: { code: 'access_token_invalid' } });

    const u = new URL(rawUrl);
    const authHeader = headerLookup(init.headers, 'authorization');

    if (u.pathname.endsWith('/v2/oauth/token')) {
      const bodyText = typeof init.body === 'string' ? init.body : '';
      const params = new URLSearchParams(bodyText);
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        const code = params.get('code');
        if (!code || code === 'bogus') return jsonResponse(400, { error: 'invalid_grant' });
        return jsonResponse(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 86_400,
          scope: scopes.join(','),
          token_type: 'Bearer',
        });
      }
      if (grant === 'refresh_token') {
        const rt = params.get('refresh_token');
        if (rt !== refreshToken) return jsonResponse(400, { error: 'invalid_grant' });
        stats.refreshes += 1;
        return jsonResponse(200, {
          access_token: `${accessToken}-r${stats.refreshes}`,
          refresh_token: refreshToken,
          expires_in: 86_400,
          scope: scopes.join(','),
          token_type: 'Bearer',
        });
      }
      return jsonResponse(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname.endsWith('/v2/oauth/revoke')) return jsonResponse(200, {});

    if (authHeader !== `Bearer ${accessToken}`)
      return jsonResponse(401, { error: { code: 'access_token_invalid' } });

    if (u.pathname.endsWith('/v2/user/info')) {
      return jsonResponse(200, {
        data: {
          user: {
            open_id: BIZ_ACCOUNT_ID,
            display_name: 'Acme Co',
            avatar_url: 'https://p16.tiktokcdn.example/acme.jpg',
            follower_count: 54321,
          },
        },
      });
    }

    if (u.pathname.endsWith('/v2/video/list')) {
      const offset = Number(u.searchParams.get('cursor') ?? '0');
      const limit = Number(u.searchParams.get('max_count') ?? pageSize);
      const { slice, cursor, has_more } = page(videos, offset, limit);
      return jsonResponse(
        200,
        { data: { videos: slice, cursor, has_more } },
        { 'x-ratelimit-remaining': '99999' },
      );
    }

    if (u.pathname.endsWith('/v2/business/comment/list')) {
      const offset = Number(u.searchParams.get('cursor') ?? '0');
      const limit = Number(u.searchParams.get('count') ?? pageSize);
      const { slice, cursor, has_more } = page(comments, offset, limit);
      return jsonResponse(200, { data: { comments: slice, cursor, has_more } });
    }

    if (u.pathname.endsWith('/v2/business/dm/list')) {
      const offset = Number(u.searchParams.get('cursor') ?? '0');
      const limit = Number(u.searchParams.get('count') ?? pageSize);
      const { slice, cursor, has_more } = page(dms, offset, limit);
      return jsonResponse(200, { data: { messages: slice, cursor, has_more } });
    }

    if (u.pathname.endsWith('/v2/business/lead/list')) {
      const offset = Number(u.searchParams.get('cursor') ?? '0');
      const limit = Number(u.searchParams.get('count') ?? pageSize);
      const { slice, cursor, has_more } = page(leads, offset, limit);
      return jsonResponse(200, { data: { leads: slice, cursor, has_more } });
    }

    if (u.pathname.endsWith('/v2/business/message/send') && init.method === 'POST') {
      const idKey = headerLookup(init.headers, 'idempotency-key');
      if (idKey && sentMessages.has(idKey)) {
        return jsonResponse(200, {
          data: { message_id: sentMessages.get(idKey), create_time: Math.floor(Date.now() / 1000) },
        });
      }
      sendCounter += 1;
      stats.sends += 1;
      const messageId = `msg_sent_${sendCounter}`;
      if (idKey) sentMessages.set(idKey, messageId);
      return jsonResponse(200, {
        data: { message_id: messageId, create_time: Math.floor(Date.now() / 1000) },
      });
    }

    if (u.pathname.endsWith('/v2/video/comment/reply') && init.method === 'POST') {
      const idKey = headerLookup(init.headers, 'idempotency-key');
      if (idKey && commentActions.has(idKey)) {
        return jsonResponse(200, { data: { comment_id: commentActions.get(idKey) } });
      }
      commentActionCounter += 1;
      stats.commentActions += 1;
      const commentId = `comment_reply_${commentActionCounter}`;
      if (idKey) commentActions.set(idKey, commentId);
      return jsonResponse(200, {
        data: { comment_id: commentId, create_time: Math.floor(Date.now() / 1000) },
      });
    }

    if (u.pathname.endsWith('/v2/video/comment/manage') && init.method === 'POST') {
      const bodyText = typeof init.body === 'string' ? init.body : '{}';
      const body = JSON.parse(bodyText) as { comment_id?: string };
      stats.commentActions += 1;
      return jsonResponse(200, {
        data: {
          comment_id: body.comment_id ?? 'unknown',
          create_time: Math.floor(Date.now() / 1000),
        },
      });
    }

    return jsonResponse(404, { error: { code: 'not_found' } });
  };

  return {
    fetch,
    videos,
    comments,
    dms,
    leads,
    accessToken,
    refreshToken,
    webhookSecret,
    businessAccountId: BIZ_ACCOUNT_ID,
    sentMessages,
    stats,
  };
}
