/**
 * A Graph API double for tests: the endpoints the connector uses, answering with the shapes
 * Meta documents (fixtures in ./fixtures mirror recorded payloads with secrets scrubbed).
 * Serves usage headers and the `facebook-api-version` header, applies the version silently
 * like Meta does, and can be switched into error modes (expired token, rate limit, 5xx).
 *
 * Not a simulation of Meta's business rules — just enough surface for the contract suite,
 * the engine's end-to-end test and the inbox scaffold.
 */
import { signHmacSha256, type WebhookRequest } from '@nexus/connector-sdk';

export type GraphDoubleOptions = {
  origin?: string;
  appId?: string;
  appSecret?: string;
  apiVersion?: string;
  /** Served version differs from the pinned one (the silent-fallback hazard). */
  servedVersion?: string;
  pageId?: string;
  pageName?: string;
  igId?: string;
  igUsername?: string;
  conversations?: number;
  messagesPerConversation?: number;
  posts?: number;
  commentsPerPost?: number;
  usagePercent?: number;
  now?: () => number;
};

export type GraphMode = 'ok' | 'expired_token' | 'rate_limited' | 'server_error' | 'missing_scope';

export function createGraphDouble(opts: GraphDoubleOptions = {}) {
  const origin = (opts.origin ?? 'https://graph.facebook.test').replace(/\/+$/, '');
  const appId = opts.appId ?? '1234567890';
  const appSecret = opts.appSecret ?? 'meta-app-secret';
  const version = opts.apiVersion ?? 'v26.0';
  const served = opts.servedVersion ?? version;
  const pageId = opts.pageId ?? '101010101010101';
  const pageName = opts.pageName ?? 'Acme Coffee';
  const igId = opts.igId ?? '17841400000000001';
  const igUsername = opts.igUsername ?? 'acmecoffee';
  const now = opts.now ?? (() => Date.now());
  const usage = { percent: opts.usagePercent ?? 12 };
  let mode: GraphMode = 'ok';
  const stats = {
    requests: 0,
    sent: [] as { psid: string; text: string; igAccount?: boolean }[],
    replies: [] as { commentId: string; text: string }[],
    hidden: [] as string[],
    deleted: [] as string[],
    subscribedFields: [] as string[],
    revoked: 0,
  };

  // ── tokens ──
  const userTokens = new Map<string, { scopes: string[]; expiresAt: number }>();
  const pageTokens = new Map<string, string>(); // token → page id
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_messaging',
    'pages_manage_engagement',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'leads_retrieval',
    'business_management',
  ];
  let seq = 0;
  const issueUser = (ttlSeconds: number) => {
    const t = `EAAB_user_${++seq}`;
    userTokens.set(t, { scopes: [...scopes], expiresAt: now() + ttlSeconds * 1000 });
    return t;
  };
  const pageTokenFor = (id: string) => {
    const t = `EAAB_page_${id}_${++seq}`;
    pageTokens.set(t, id);
    return t;
  };

  // ── data (customer psids stay stable across polls and webhooks) ──
  const t0 = now() - 3 * 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
  const conversations = Array.from({ length: opts.conversations ?? 7 }, (_, i) => {
    const psid = `24${String(100000000 + i).padStart(9, '0')}`;
    const msgs = Array.from({ length: opts.messagesPerConversation ?? 3 }, (_, j) => ({
      id: `m_${i}_${j}`,
      message:
        j % 2 === 0
          ? `Hi, is the ${['espresso', 'grinder', 'subscription'][i % 3]} in stock?`
          : 'Yes — want me to hold one for you?',
      created_time: iso(t0 + i * 3_600_000 + j * 600_000),
      from: j % 2 === 0 ? { id: psid, name: `Customer ${i + 1}` } : { id: pageId, name: pageName },
      to: {
        data: [
          j % 2 === 0 ? { id: pageId, name: pageName } : { id: psid, name: `Customer ${i + 1}` },
        ],
      },
    }));
    return {
      id: `t_${i}`,
      psid,
      updated_time: msgs.at(-1)!.created_time,
      snippet: msgs.at(-1)!.message,
      message_count: msgs.length,
      unread_count: 0,
      link: `/${pageId}/inbox/${i}`,
      participants: {
        data: [
          { id: psid, name: `Customer ${i + 1}` },
          { id: pageId, name: pageName },
        ],
      },
      messages: { data: [...msgs].reverse() },
    };
  });
  const posts = Array.from({ length: opts.posts ?? 4 }, (_, i) => ({
    id: `${pageId}_${5000 + i}`,
    message: `Post ${i + 1}: new single-origin roast this week`,
    created_time: iso(t0 + i * 7_200_000),
    permalink_url: `https://www.facebook.com/${pageId}/posts/${5000 + i}`,
    from: { id: pageId, name: pageName },
    comments: {
      data: Array.from({ length: opts.commentsPerPost ?? 3 }, (_, j) => ({
        id: `${5000 + i}_${9000 + j}`,
        message: j === 0 ? 'How much is a bag?' : `Comment ${j}`,
        created_time: iso(t0 + i * 7_200_000 + j * 60_000),
        from: { id: `24${String(200000000 + j).padStart(9, '0')}`, name: `Fan ${j + 1}` },
        is_hidden: false,
        permalink_url: `https://www.facebook.com/${pageId}/posts/${5000 + i}?comment_id=${9000 + j}`,
      })),
    },
  }));
  const media = Array.from({ length: opts.posts ?? 4 }, (_, i) => ({
    id: `1789${String(i).padStart(12, '0')}`,
    caption: `Reel ${i + 1} ☕`,
    timestamp: iso(t0 + i * 5_400_000),
    permalink: `https://www.instagram.com/p/ABC${i}/`,
    media_type: i % 2 ? 'VIDEO' : 'IMAGE',
    media_url: `https://scontent.test/media/${i}.jpg`,
    like_count: 10 + i,
    comments_count: opts.commentsPerPost ?? 3,
    username: igUsername,
    owner: { id: igId },
    comments: {
      data: Array.from({ length: opts.commentsPerPost ?? 3 }, (_, j) => ({
        id: `1799${String(i * 10 + j).padStart(12, '0')}`,
        text: j === 0 ? 'price?' : `nice ${j}`,
        timestamp: iso(t0 + i * 5_400_000 + j * 60_000),
        username: `fan_${j}`,
        from: { id: `1780${String(300 + j).padStart(12, '0')}`, username: `fan_${j}` },
        hidden: false,
        like_count: j,
        replies:
          j === 0
            ? {
                data: [
                  {
                    id: `1799${String(i * 10 + 9).padStart(12, '0')}`,
                    text: 'DM sent!',
                    timestamp: iso(t0 + i * 5_400_000 + 120_000),
                    username: igUsername,
                    from: { id: igId, username: igUsername },
                    hidden: false,
                  },
                ],
              }
            : undefined,
      })),
    },
  }));

  const usageHeaders = () => ({
    'x-app-usage': JSON.stringify({
      call_count: usage.percent,
      total_cputime: Math.max(0, usage.percent - 5),
      total_time: Math.max(0, usage.percent - 3),
    }),
    'x-business-use-case-usage': JSON.stringify({
      '9876543210': [
        {
          type: 'pages',
          call_count: usage.percent,
          total_cputime: 1,
          total_time: 1,
          estimated_time_to_regain_access: usage.percent >= 100 ? 15 : 0,
        },
      ],
    }),
    'facebook-api-version': served,
    'content-type': 'application/json',
  });
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...usageHeaders(), ...headers } });
  const graphError = (status: number, code: number, message: string, subcode?: number) =>
    json(status, {
      error: {
        message,
        type: 'OAuthException',
        code,
        ...(subcode ? { error_subcode: subcode } : {}),
        fbtrace_id: 'AbCdEf',
      },
    });

  function pageOf<T>(
    all: T[],
    q: URLSearchParams,
    path: string,
  ): { data: T[]; paging?: { cursors: { before: string; after: string }; next?: string } } {
    const limit = Math.max(1, Number(q.get('limit') ?? 25) || 25);
    const offset = q.get('after')
      ? Number(Buffer.from(q.get('after')!, 'base64url').toString('utf8')) || 0
      : 0;
    const data = all.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const after = Buffer.from(String(nextOffset)).toString('base64url');
    return {
      data,
      paging: {
        cursors: { before: Buffer.from(String(offset)).toString('base64url'), after },
        ...(nextOffset < all.length ? { next: `${origin}/${version}${path}?after=${after}` } : {}),
      },
    };
  }

  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    stats.requests += 1;
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== origin) return new Response('wrong host', { status: 502 });
    const method = (init.method ?? 'GET').toUpperCase();
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] !== version)
      return graphError(400, 2500, `Unknown path components: /${segs.join('/')}`);
    const path = `/${segs.slice(1).join('/')}`;
    const q = u.searchParams;
    const headers = new Headers(init.headers);
    const auth =
      headers.get('authorization')?.replace(/^Bearer /, '') ?? q.get('access_token') ?? '';

    // ── OAuth ──
    if (path === '/oauth/access_token') {
      if (q.get('client_id') !== appId || q.get('client_secret') !== appSecret)
        return graphError(400, 101, 'Error validating application. Invalid application ID.');
      if (q.get('grant_type') === 'fb_exchange_token') {
        const src = q.get('fb_exchange_token') ?? '';
        if (!userTokens.has(src))
          return graphError(400, 190, 'Error validating access token: Session has expired.', 463);
        return json(200, {
          access_token: issueUser(60 * 86_400),
          token_type: 'bearer',
          expires_in: 5_184_000,
        });
      }
      if (!q.get('code')?.startsWith('AQ'))
        return graphError(400, 100, 'Invalid verification code format.');
      return json(200, {
        access_token: issueUser(3600),
        token_type: 'bearer',
        expires_in: 5_183_944,
      });
    }
    // ── errors by mode ──
    if (mode === 'expired_token' || (!userTokens.has(auth) && !pageTokens.has(auth)))
      return graphError(
        400,
        190,
        'Error validating access token: Session has expired on Tuesday, 22-Sep-26 09:00:00 PDT.',
        463,
      );
    if (mode === 'rate_limited') {
      usage.percent = 100;
      return graphError(400, 4, 'Application request limit reached');
    }
    if (mode === 'server_error')
      return json(500, {
        error: { message: 'An unknown error occurred', type: 'OAuthException', code: 1 },
      });
    if (mode === 'missing_scope' && method === 'POST')
      return graphError(403, 200, 'Requires pages_messaging permission to manage the object');

    if (path === '/me/permissions') {
      if (method === 'DELETE') {
        stats.revoked += 1;
        userTokens.delete(auth);
        return json(200, { success: true });
      }
      return json(200, { data: scopes.map((p) => ({ permission: p, status: 'granted' })) });
    }
    if (path === '/me/accounts') {
      return json(200, {
        data: [
          {
            id: pageId,
            name: pageName,
            access_token: pageTokenFor(pageId),
            picture: { data: { url: 'https://scontent.test/pic.jpg' } },
            instagram_business_account: {
              id: igId,
              username: igUsername,
              name: 'Acme Coffee',
              profile_picture_url: 'https://scontent.test/ig.jpg',
            },
          },
        ],
        paging: { cursors: { before: 'a', after: 'b' } },
      });
    }
    const [node, edge] = [segs[1], segs[2]];
    if (node === pageId || node === igId) {
      const isIg = node === igId;
      if (!edge && method === 'GET')
        return json(
          200,
          isIg ? { id: igId, username: igUsername } : { id: pageId, name: pageName },
        );
      if (edge === 'conversations') {
        // The same threads exist on both nodes; on the Instagram node the account party is the IG account.
        const swap = (id: string) => (isIg && id === pageId ? igId : id);
        const rows = conversations.map(({ psid: _p, ...c }) => ({
          ...c,
          participants: { data: c.participants.data.map((p) => ({ ...p, id: swap(p.id) })) },
          messages: {
            data: c.messages.data.map((m) => ({
              ...m,
              from: { ...m.from, id: swap(m.from.id) },
              to: { data: m.to.data.map((t) => ({ ...t, id: swap(t.id) })) },
            })),
          },
        }));
        return json(200, pageOf(rows, q, path));
      }
      if (edge === 'feed') return json(200, pageOf(posts, q, path));
      if (edge === 'tagged')
        return json(
          200,
          pageOf(
            [
              {
                id: `${pageId}_7001`,
                message: `Loved my visit to @${pageName}`,
                created_time: iso(t0 + 1000),
                from: { id: '24300000001', name: 'Local Guide' },
                permalink_url: `https://www.facebook.com/24300000001/posts/7001`,
              },
            ],
            q,
            path,
          ),
        );
      if (edge === 'ratings')
        return json(
          200,
          pageOf(
            [
              {
                reviewer: { id: '24300000002', name: 'Regular' },
                rating: 5,
                recommendation_type: 'positive',
                review_text: 'Best flat white in town',
                created_time: iso(t0 + 2000),
                open_graph_story: { id: 'og_1' },
              },
              {
                recommendation_type: 'negative',
                review_text: 'Slow service',
                created_time: iso(t0 + 3000),
                open_graph_story: { id: 'og_2' },
              },
            ],
            q,
            path,
          ),
        );
      if (edge === 'leadgen_forms')
        return json(
          200,
          pageOf(
            [
              {
                id: 'form_1',
                name: 'Wholesale enquiry',
                status: 'ACTIVE',
                leads: {
                  data: [
                    {
                      id: 'lead_1',
                      created_time: iso(t0 + 4000),
                      form_id: 'form_1',
                      ad_id: 'ad_1',
                      campaign_id: 'camp_1',
                      field_data: [
                        { name: 'full_name', values: ['Dana Wholesale'] },
                        { name: 'email', values: ['dana@wholesale.test'] },
                        { name: 'phone_number', values: ['+15555550123'] },
                        { name: 'company', values: ['Wholesale Co'] },
                      ],
                    },
                  ],
                },
              },
            ],
            q,
            path,
          ),
        );
      if (edge === 'insights') {
        const metrics = (q.get('metric') ?? '').split(',');
        if (q.get('metric') === 'follower_demographics')
          return json(200, {
            data: [
              {
                name: 'follower_demographics',
                period: 'lifetime',
                total_value: {
                  breakdowns: [
                    {
                      dimension_keys: ['country'],
                      results: [
                        { dimension_values: ['US'], value: 812 },
                        { dimension_values: ['GB'], value: 233 },
                      ],
                    },
                  ],
                },
              },
            ],
          });
        return json(200, {
          data: metrics.map((m, i) => ({
            name: m,
            period: 'day',
            values: [
              { value: 100 + i, end_time: iso(t0 + 86_400_000) },
              { value: 120 + i, end_time: iso(t0 + 2 * 86_400_000) },
            ],
            id: `${node}/insights/${m}/day`,
          })),
        });
      }
      if (edge === 'media') return json(200, pageOf(media, q, path));
      if (edge === 'tags')
        return json(
          200,
          pageOf(
            [
              {
                id: '1789000000000099',
                caption: `great beans @${igUsername}`,
                username: 'coffee_nerd',
                timestamp: iso(t0 + 5000),
                permalink: 'https://www.instagram.com/p/XYZ/',
                media_type: 'IMAGE',
                owner: { id: '1780000000000999' },
              },
            ],
            q,
            path,
          ),
        );
      if (edge === 'subscribed_apps' && method === 'POST') {
        stats.subscribedFields = (q.get('subscribed_fields') ?? '').split(',').filter(Boolean);
        return json(200, { success: true });
      }
      if (edge === 'messages' && method === 'POST') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
          recipient?: { id?: string };
          message?: { text?: string };
        };
        const psid = body.recipient?.id ?? '';
        if (!conversations.some((c) => c.psid === psid))
          return graphError(400, 100, 'No matching user found', 2018001);
        stats.sent.push({ psid, text: body.message?.text ?? '', igAccount: isIg });
        return json(200, { recipient_id: psid, message_id: `m_out_${++seq}` });
      }
    }
    if (node && (edge === 'comments' || edge === 'replies') && method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        message?: string;
      };
      stats.replies.push({ commentId: node, text: body.message ?? '' });
      return json(200, { id: `${node}_reply_${++seq}` });
    }
    if (node && !edge && method === 'POST' && (q.has('is_hidden') || q.has('hide'))) {
      stats.hidden.push(node);
      return json(200, { success: true });
    }
    if (node && !edge && method === 'DELETE') {
      stats.deleted.push(node);
      return json(200, { success: true });
    }
    return graphError(
      404,
      803,
      `Unsupported get request. Object with ID '${node ?? ''}' does not exist`,
    );
  };

  // ── webhooks ──
  function sign(body: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-hub-signature-256': signHmacSha256(body, appSecret),
      'x-hub-signature': 'sha1=deprecated',
    };
  }
  const webhook = (body: unknown, path = '/api/webhooks/facebook'): WebhookRequest => {
    const text = JSON.stringify(body);
    return {
      method: 'POST',
      path,
      headers: sign(text),
      rawBody: Buffer.from(text, 'utf8'),
      query: {},
    };
  };
  const messageWebhook = (input: {
    psid?: string;
    text: string;
    at?: number;
    echo?: boolean;
    ig?: boolean;
  }) => {
    const psid = input.psid ?? conversations[0]!.psid;
    const at = input.at ?? now();
    const account = input.ig ? igId : pageId;
    const mid = `m_wh_${++seq}`;
    return webhook(
      {
        object: input.ig ? 'instagram' : 'page',
        entry: [
          {
            id: account,
            time: at,
            messaging: [
              {
                sender: { id: input.echo ? account : psid },
                recipient: { id: input.echo ? psid : account },
                timestamp: at,
                message: { mid, text: input.text, ...(input.echo ? { is_echo: true } : {}) },
              },
            ],
          },
        ],
      },
      input.ig ? '/api/webhooks/instagram' : '/api/webhooks/facebook',
    );
  };
  const commentWebhook = (input: {
    postId?: string;
    commentId?: string;
    text: string;
    from?: { id: string; name: string };
    at?: number;
  }) => {
    const at = Math.floor((input.at ?? now()) / 1000);
    const post = input.postId ?? posts[0]!.id;
    return webhook({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: at,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: input.commentId ?? `${post.split('_')[1]}_${++seq}`,
                post_id: post,
                parent_id: post,
                message: input.text,
                created_time: at,
                from: input.from ?? { id: '24300000009', name: 'Webhook Fan' },
              },
            },
          ],
        },
      ],
    });
  };
  const leadgenWebhook = (leadgenId = `lead_wh_${++seq}`) =>
    webhook({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: Math.floor(now() / 1000),
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: leadgenId,
                form_id: 'form_1',
                page_id: pageId,
                ad_id: 'ad_1',
                created_time: Math.floor(now() / 1000),
              },
            },
          ],
        },
      ],
    });
  const igCommentWebhook = (input: { mediaId?: string; text: string; at?: number }) =>
    webhook(
      {
        object: 'instagram',
        entry: [
          {
            id: igId,
            time: input.at ?? now(),
            changes: [
              {
                field: 'comments',
                value: {
                  id: `1799${String(++seq).padStart(12, '0')}`,
                  text: input.text,
                  media: { id: input.mediaId ?? media[0]!.id, media_product_type: 'FEED' },
                  from: { id: '1780000000000777', username: 'wh_fan' },
                },
              },
            ],
          },
        ],
      },
      '/api/webhooks/instagram',
    );
  const igMentionWebhook = () =>
    webhook(
      {
        object: 'instagram',
        entry: [
          {
            id: igId,
            time: now(),
            changes: [
              {
                field: 'mentions',
                value: { media_id: '1789000000000099', comment_id: '1799000000000098' },
              },
            ],
          },
        ],
      },
      '/api/webhooks/instagram',
    );

  return {
    origin,
    appId,
    appSecret,
    version,
    pageId,
    pageName,
    igId,
    igUsername,
    conversations,
    posts,
    media,
    stats,
    fetch: fetchImpl,
    setMode(next: GraphMode) {
      mode = next;
    },
    setUsagePercent(p: number) {
      usage.percent = p;
    },
    setServedVersion(v: string) {
      // The silent-fallback hazard: Meta keeps answering, just on another version.
      (usageHeaders as unknown as { served?: string }).served = v;
    },
    issueUserToken: (ttlSeconds = 60 * 86_400) => issueUser(ttlSeconds),
    issuePageToken: (id: string = pageId) => pageTokenFor(id),
    expireUserToken: (t: string) => userTokens.delete(t),
    webhook,
    messageWebhook,
    commentWebhook,
    leadgenWebhook,
    igCommentWebhook,
    igMentionWebhook,
  };
}

export type GraphDouble = ReturnType<typeof createGraphDouble>;
