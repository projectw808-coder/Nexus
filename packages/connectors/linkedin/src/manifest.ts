import { connectorManifestSchema, type ConnectorManifest } from '@nexus/connector-sdk';

export const KINDS = {
  post: 'li_post',
  comment: 'li_comment',
  lead: 'li_lead',
} as const;

/**
 * LinkedIn (spec §8, Phase 8). Vanilla 3-legged OAuth 2.0 — no PKCE requirement is documented
 * for LinkedIn, so this connector uses the SDK's plain OAuth2 helpers, not the PKCE ones.
 *
 * `apiVersion` is a `YYYYMM` string (LinkedIn's monthly API versioning) sent as the
 * `LinkedIn-Version` HTTP HEADER on every outbound request — never a URL segment. Every
 * `ctx.http.request()` call in `connector.ts` sets `headers: { 'LinkedIn-Version': ctx.apiVersion }`.
 *
 * No `apiVersionHeader` here on purpose: that field is for a RESPONSE header the platform
 * echoes its served version back in, and there is no confirmed public documentation that
 * LinkedIn echoes one — leaving it unset avoids asserting a served-version drift check this
 * connector cannot back up (see docs §10).
 *
 * Member identity uses OIDC (`openid`/`profile`/`email` — LinkedIn's "Sign In with LinkedIn
 * v2"). `r_liteprofile`/`r_emailaddress` were RETIRED by LinkedIn in 2023 and must never be
 * requested; the OIDC scopes below replace them.
 *
 * Organization content (Community Management API) and Lead Sync additionally require an
 * application approved for LinkedIn's Marketing Developer Platform. "Not yet approved" is a
 * first-class, expected connection state here (surfaced via `verifyScopes()` degrading
 * `read:posts`/`read:comments`/`read:leads`, and via `health()`'s `approval` check) — never
 * treated as an error.
 */
export const linkedinManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'LINKEDIN',
  displayName: 'LinkedIn',
  apiVersion: '202609',
  docsUrl:
    'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-integrations-overview',
  authKind: 'oauth2',
  scopes: [
    {
      id: 'openid',
      plainLanguage: 'Confirm who you are on LinkedIn',
      requiredFor: [],
      sensitive: false,
    },
    {
      id: 'profile',
      plainLanguage: 'See your name and profile picture',
      requiredFor: [],
      sensitive: false,
    },
    {
      id: 'email',
      plainLanguage: 'See your email address',
      requiredFor: [],
      sensitive: false,
    },
    // r_liteprofile / r_emailaddress were retired by LinkedIn in 2023 — never request them.
    // openid/profile/email (above) are their OIDC replacements for member identity.
    {
      id: 'r_organization_social',
      plainLanguage: "Read your organization pages' posts, comments and reactions",
      requiredFor: ['read:posts', 'read:comments'],
      sensitive: true,
    },
    {
      id: 'w_organization_social',
      plainLanguage: 'Post and comment as your organization pages',
      // No write capability is implemented this phase — declared so the scope exists in the
      // consent checklist and the manifest schema, but nothing currently depends on it.
      requiredFor: [],
      sensitive: true,
    },
    {
      id: 'rw_organization_admin',
      plainLanguage: 'See which organization pages you administer',
      // Needed for organizationAcls discovery — without it there is no way to find which
      // organizations to poll, so it gates the same read capabilities as r_organization_social.
      requiredFor: ['read:posts', 'read:comments'],
      sensitive: true,
    },
    {
      id: 'r_ads',
      plainLanguage: 'Read your ad accounts and campaigns',
      requiredFor: [],
      sensitive: true,
    },
    {
      id: 'r_marketing_leadgen_automation',
      plainLanguage: 'Read leads submitted through your Lead Gen Forms',
      requiredFor: ['read:leads'],
      sensitive: true,
    },
  ],
  resources: [
    {
      id: 'li.posts',
      displayName: 'Organization posts',
      kinds: [KINDS.post],
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
      overlapSeconds: 120,
    },
    {
      id: 'li.comments',
      displayName: 'Organization post comments',
      kinds: [KINDS.comment],
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
      overlapSeconds: 120,
    },
    {
      id: 'li.leads',
      displayName: 'Lead Gen Form submissions',
      kinds: [KINDS.lead],
      // Still reconciliation-polled even where Lead Sync push is approved (spec §9.1) — a
      // webhook is a hint, never a replacement for the poll.
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'webhook'] },
      overlapSeconds: 120,
    },
  ],
  capabilities: ['read:posts', 'read:comments', 'read:leads'],
  // LinkedIn publishes no single clean cross-product rate-limit figure — real limits are
  // per-app-per-day and vary by product tier/approval. This is a CONSERVATIVE PLACEHOLDER
  // pending the customer's actual approved throughput; re-verify against LinkedIn's Developer
  // Portal for the specific product tier before relying on it (see docs §8).
  quota: { kind: 'fixed_window', windowSeconds: 86400, limit: 100000 },
  webhooks: {
    supported: true,
    verification: 'shared_secret',
    resources: ['li.leads'],
    replayable: false,
  },
  constraints: [
    "Community Management API and Lead Sync require an approved application to LinkedIn's Marketing Developer Platform — treat 'not yet approved' as a first-class connection state, not an error.",
    'Member-to-member DMs are not available on this API — never promise them.',
    'r_liteprofile/r_emailaddress were retired in 2023 and must never be requested.',
  ],
  tierNotes:
    'Member identity (openid/profile/email) needs no review. Organization content and Lead Sync need LinkedIn Marketing Developer Platform approval — until granted, the connection still connects with member-only identity and read:posts/read:comments/read:leads are degraded (see health()\'s "approval" check).',
} satisfies ConnectorManifest);
