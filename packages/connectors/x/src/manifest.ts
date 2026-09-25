import { connectorManifestSchema, type ConnectorManifest } from '@nexus/connector-sdk';

export const KINDS = { mention: 'x_mention', dm: 'x_dm_event' } as const;

/** Default page size assumed when a caller does not request one — used both to size the
 *  reserve-time estimate in `fetchPage` and the quota simulator's `costPerPage` figures below. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * X's per-use rate card (spec §8.2), in USD. Read costs are per RESOURCE ITEM, not per API call —
 * `connector.ts` reserves `pageSize * rate` before a page fetch and settles with
 * `items.length * rate` once it knows how many rows actually came back. `reply_dm_url` is the
 * 13x-inflated cost X charges when a DM body contains a link.
 *
 * NOT verified against X's live developer portal (no live X app exists in this environment) —
 * these figures are carried over from the product spec and MUST be re-checked before go-live;
 * see `docs/connectors/x.md` §8 and §15. X's billing terms are described as changing quarterly.
 */
export const RATE_CARD = {
  'x.mentions': 0.005,
  'x.dms': 0.01,
  reply_dm: 0.015,
  reply_dm_url: 0.2,
} as const;

/**
 * X (Twitter) API v2 connector (spec §8.2, ADR-019 Phase 8). OAuth2 + PKCE, user-context.
 * Billed on `metered_credits` — every connection MUST carry a `ConnectionSettings.spendCap`
 * before any read or write is allowed (enforced by the SDK rate limiter, not this connector).
 *
 * X's classic Account Activity webhooks are deprecated; the filtered stream (a persistent HTTP
 * connection) is the lower-latency alternative the spec recommends, but a real streaming
 * connection is out of scope for this connector today — delta ingestion polls instead
 * (`webhooks.supported: false`; see docs "Not supported").
 */
export const xManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'X',
  displayName: 'X',
  apiVersion: '2',
  docsUrl: 'https://developer.x.com/en/docs/x-api',
  authKind: 'oauth2_pkce',
  scopes: [
    {
      id: 'tweet.read',
      plainLanguage: 'Read your posts and the posts that mention you',
      requiredFor: ['read:mentions'],
      sensitive: false,
    },
    {
      id: 'tweet.write',
      plainLanguage: 'Post and reply to posts on X on your behalf',
      // Public post replies are not implemented by this connector yet (read-only for posts);
      // requested now so the same app registration covers a later `reply_comment` capability
      // without a re-consent round trip.
      requiredFor: [],
      sensitive: false,
    },
    {
      id: 'dm.read',
      plainLanguage: 'Read your direct messages',
      requiredFor: ['read:messages'],
      sensitive: true,
    },
    {
      id: 'dm.write',
      plainLanguage: 'Send direct messages on your behalf',
      requiredFor: ['write:reply_dm'],
      sensitive: true,
    },
    {
      id: 'users.read',
      plainLanguage: 'Look up your profile and the people you interact with',
      requiredFor: ['read:mentions', 'read:messages'],
      sensitive: false,
    },
    {
      id: 'offline.access',
      plainLanguage: 'Stay connected without you having to re-authorize every session',
      requiredFor: [],
      sensitive: false,
    },
  ],
  resources: [
    {
      id: 'x.mentions',
      displayName: 'Mentions',
      kinds: [KINDS.mention],
      defaultIntervalSeconds: 300,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: DEFAULT_PAGE_SIZE * RATE_CARD['x.mentions'],
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
    {
      id: 'x.dms',
      displayName: 'Direct messages',
      kinds: [KINDS.dm],
      defaultIntervalSeconds: 300,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: DEFAULT_PAGE_SIZE * RATE_CARD['x.dms'],
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'interactive'] },
    },
  ],
  capabilities: ['read:mentions', 'read:messages', 'write:reply_dm'],
  quota: {
    kind: 'metered_credits',
    currency: 'USD',
    rateCard: RATE_CARD,
    cycleCapUnits: 3_000_000,
    dedupWindowHours: 24,
    spendCapRequired: true,
  },
  webhooks: {
    supported: false,
    verification: 'none',
    resources: [],
    replayable: false,
  },
  constraints: [
    'Reads are deduplicated within a rolling 24h UTC window: re-polling the same resource for ' +
      "the same account inside that window costs nothing, and is enforced by the SDK's dedup ledger.",
    'A DM reply whose text contains a URL costs 13x a plain reply ($0.20 vs $0.015) — flagged as ' +
      'a preflight warning, never blocked.',
    'Deleted posts and DMs must be honoured as tombstones (`isDeleted: true`), never dropped ' +
      'from the sync.',
    'DM access needs both the dm.read and dm.write scopes; mentions only need tweet.read and users.read.',
    'A monthly spend cap (`ConnectionSettings.spendCap`) is required before any metered call is made.',
  ],
  tierNotes:
    'Requires a paid X API tier (Basic or above) for meaningful mention/DM volume; the Free tier ' +
    'has no read access. Rate-card figures and the cycle cap are from the product spec (§8.2), ' +
    'not a live check against developer.x.com — X is described as changing its billing terms ' +
    'quarterly, so re-verify before go-live (see docs/connectors/x.md).',
} satisfies ConnectorManifest);
