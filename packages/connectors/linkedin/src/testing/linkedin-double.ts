/**
 * A scripted double for LinkedIn: just enough surface for the contract suite and this
 * connector's own tests (OAuth2 token/refresh/revoke, `organizationAcls` discovery, paginated
 * posts/comments/leads, 401/429 scenarios, a Lead Sync webhook payload builder). Not a business
 * simulator — see `@nexus/connector-meta`'s Graph double for the fuller pattern this follows.
 *
 * State (`posts`/`comments`/`leads`) is closed over by the returned `fetch`, so a fresh `ConnCtx`
 * built against the SAME double instance sees the SAME data — required by the contract suite's
 * cursor-resume test, which builds a second context mid-test.
 */
import { jsonResponse } from '@nexus/connector-sdk/testing';
import type { FetchLike } from '@nexus/connector-sdk';

export type LinkedInDoublePost = Record<string, unknown> & {
  id: string;
  author: string;
  commentary: string;
  createdAt: number;
  lifecycleState: string;
  visibility: string;
  contentType: string;
};

export type LinkedInDoubleComment = Record<string, unknown> & {
  id: string;
  object: string;
  actor: string;
  message: { text: string };
  created: number;
};

export type LinkedInDoubleLead = Record<string, unknown> & {
  id: string;
  formId: string;
  formName: string;
  owner: string;
  submittedAt: number;
  answers: { questionId: string; question: string; answer: string | null }[];
};

function headerLookup(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function postFixture(i: number, overrides: Partial<LinkedInDoublePost> = {}) {
  return {
    id: `urn:li:share:${7000000 + i}`,
    author: 'urn:li:organization:123456',
    commentary: `Post number ${i}`,
    createdAt: Date.UTC(2026, 8, 1, 0, i),
    lastModifiedAt: Date.UTC(2026, 8, 1, 0, i),
    lifecycleState: 'PUBLISHED',
    visibility: 'PUBLIC',
    contentType: i % 3 === 0 ? 'IMAGE' : 'NONE',
    totalSocialActivityCounts: { numLikes: i, numComments: i % 5, numShares: 0, numViews: i * 10 },
    ...overrides,
  } satisfies LinkedInDoublePost;
}

export function commentFixture(i: number, overrides: Partial<LinkedInDoubleComment> = {}) {
  return {
    id: `urn:li:comment:(urn:li:share:7000000,${8000000 + i})`,
    object: 'urn:li:share:7000000',
    actor: `urn:li:person:member-${i}`,
    message: { text: `Comment number ${i}` },
    created: Date.UTC(2026, 8, 1, 1, i),
    lastModified: Date.UTC(2026, 8, 1, 1, i),
    parentComment: null,
    ...overrides,
  } satisfies LinkedInDoubleComment;
}

export function leadFixture(i: number, overrides: Partial<LinkedInDoubleLead> = {}) {
  return {
    id: `urn:li:leadFormResponse:${9000000 + i}`,
    formId: 'urn:li:leadForm:555',
    formName: 'Contact us',
    owner: 'urn:li:organization:123456',
    campaign: 'urn:li:sponsoredCampaign:42',
    submittedAt: Date.UTC(2026, 8, 1, 2, i),
    testLead: false,
    consentToMarketing: true,
    answers: [
      { questionId: 'q1', question: 'First Name', answer: `Lead${i}` },
      { questionId: 'q2', question: 'Last Name', answer: 'Example' },
      { questionId: 'q3', question: 'Email', answer: `lead${i}@example.com` },
      { questionId: 'q4', question: 'Phone Number', answer: '+14155550100' },
    ],
    ...overrides,
  } satisfies LinkedInDoubleLead;
}

export function leadWebhookPayload(lead: LinkedInDoubleLead): {
  leadId: string;
  formId: string;
  owner: string;
} {
  return { leadId: lead.id, formId: lead.formId, owner: lead.owner };
}

export function createLinkedInDouble(
  opts: {
    totalPosts?: number;
    totalComments?: number;
    totalLeads?: number;
    accessToken?: string;
    orgUrn?: string;
    forceStatus?: 401 | 429;
    posts?: LinkedInDoublePost[];
    comments?: LinkedInDoubleComment[];
    leads?: LinkedInDoubleLead[];
  } = {},
): {
  fetch: FetchLike;
  accessToken: string;
  orgUrn: string;
  posts: LinkedInDoublePost[];
  comments: LinkedInDoubleComment[];
  leads: LinkedInDoubleLead[];
  /** Every request the double served, headers included — asserts `LinkedIn-Version` was sent. */
  requests: { url: string; method: string; headers: Record<string, string> }[];
} {
  const accessToken = opts.accessToken ?? 'test-access-token';
  const orgUrn = opts.orgUrn ?? 'urn:li:organization:123456';
  const posts =
    opts.posts ?? Array.from({ length: opts.totalPosts ?? 25 }, (_, i) => postFixture(i));
  const comments =
    opts.comments ?? Array.from({ length: opts.totalComments ?? 25 }, (_, i) => commentFixture(i));
  const leads =
    opts.leads ?? Array.from({ length: opts.totalLeads ?? 25 }, (_, i) => leadFixture(i));
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];

  const paged = <T>(items: T[], u: URL) => {
    const start = Number(u.searchParams.get('start') ?? '0');
    const count = Number(u.searchParams.get('count') ?? '10');
    const slice = items.slice(start, start + count);
    return jsonResponse(200, { elements: slice, paging: { start, count, total: items.length } });
  };

  const fetch: FetchLike = async (rawUrl, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = init.method ?? 'GET';
    requests.push({ url: String(rawUrl), method, headers });

    const u = new URL(rawUrl);

    if (u.pathname === '/oauth/v2/accessToken' && method === 'POST') {
      if (opts.forceStatus === 401) return jsonResponse(401, { error: 'invalid_grant' });
      return jsonResponse(200, {
        access_token: accessToken,
        expires_in: 5_184_000,
        scope: 'openid,profile,email',
      });
    }
    if (u.pathname === '/oauth/v2/revoke' && method === 'POST') {
      return jsonResponse(200, {});
    }

    if (opts.forceStatus === 429)
      return jsonResponse(429, { message: 'rate_limited' }, { 'retry-after': '1' });
    if (opts.forceStatus === 401)
      return jsonResponse(401, { message: 'invalid access token', serviceErrorCode: 65601 });

    const bearer = headerLookup(headers, 'authorization');
    if (bearer !== `Bearer ${accessToken}`)
      return jsonResponse(401, { message: 'invalid access token', serviceErrorCode: 65601 });

    if (u.pathname === '/v2/userinfo') {
      return jsonResponse(200, {
        sub: 'member-1',
        name: 'Test Member',
        email: 'member@example.com',
      });
    }
    if (u.pathname === '/rest/organizationAcls') {
      return jsonResponse(200, {
        elements: [
          {
            organizationalTarget: orgUrn,
            role: 'ADMINISTRATOR',
            state: 'APPROVED',
            'organizationalTarget~': { localizedName: 'Acme Corp', vanityName: 'acme-corp' },
          },
        ],
      });
    }
    if (u.pathname === '/rest/posts') return paged(posts, u);
    if (u.pathname === '/rest/organizationalEntityComments') return paged(comments, u);
    if (u.pathname === '/rest/leadFormResponses') return paged(leads, u);
    if (u.pathname === '/rest/leadNotifications' && method === 'POST') {
      return jsonResponse(200, { id: 'urn:li:leadNotificationConfig:1' });
    }

    return jsonResponse(404, { message: 'not_found' });
  };

  return { fetch, accessToken, orgUrn, posts, comments, leads, requests };
}
