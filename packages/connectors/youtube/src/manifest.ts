import { connectorManifestSchema, type ConnectorManifest } from '@nexus/connector-sdk';

export const KINDS = {
  video: 'yt_video',
  commentThread: 'yt_comment_thread',
  searchResult: 'yt_search_result',
} as const;

/**
 * YouTube Data API v3 (spec §7.3, ADR-019, docs/ARCHITECTURE.md "Things I checked rather than
 * assumed"): 10,000 units/day resetting at midnight Pacific, reads cost 1 unit, writes cost 50.
 * `search.list` and `videos.insert` EACH additionally sit in their own 100-calls/day bucket,
 * tracked independently of the unit pool by the SDK's `daily_units` rate limiter. Because 100
 * calls/day is exhausted almost instantly by any automated loop, `search.list` is deliberately
 * NOT a schedulable resource here — video discovery instead walks the channel's uploads playlist
 * with `playlistItems.list` (see `connector.ts`'s `fetchPage` for the `yt.search` refusal path).
 */
export const youtubeManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'YOUTUBE',
  displayName: 'YouTube',
  apiVersion: 'v3',
  docsUrl: 'https://developers.google.com/youtube/v3/docs',
  authKind: 'oauth2',
  scopes: [
    {
      id: 'https://www.googleapis.com/auth/youtube.readonly',
      plainLanguage: 'See your channel, its videos and the comments on them',
      requiredFor: ['read:posts', 'read:comments'],
      sensitive: false,
    },
    {
      id: 'https://www.googleapis.com/auth/youtube.force-ssl',
      plainLanguage: 'Reply to and moderate comments on your videos',
      requiredFor: ['write:reply_comment'],
      sensitive: true,
    },
    {
      id: 'https://www.googleapis.com/auth/yt-analytics.readonly',
      plainLanguage: 'See performance analytics for your channel and videos',
      requiredFor: ['read:insights'],
      sensitive: true,
    },
  ],
  // Only two schedulable resources on purpose — there is NO `search.list`-backed resource here.
  // `search.list` is still reachable through `fetchPage({ id: 'yt.search' })` for an explicit,
  // user-initiated, `interactive`-lane search, but it is never something the sync engine can
  // schedule because it does not appear below.
  resources: [
    {
      id: 'yt.videos',
      displayName: 'Videos',
      kinds: [KINDS.video],
      defaultIntervalSeconds: 3600,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
    {
      id: 'yt.comments',
      displayName: 'Comment threads',
      kinds: [KINDS.commentThread],
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
  ],
  capabilities: ['read:posts', 'read:comments', 'write:reply_comment', 'read:insights'],
  quota: {
    kind: 'daily_units',
    dailyUnits: 10_000,
    resetTimezone: 'America/Los_Angeles',
    unitCosts: {
      'playlistItems.list': 1,
      'commentThreads.list': 1,
      'comments.list': 1,
      'comments.insert': 50,
      'search.list': 1,
      'videos.insert': 50,
    },
    defaultUnitCost: 1,
    // Tracked independently of the unit pool above — a call is refused if EITHER bucket is empty.
    cappedEndpoints: { 'search.list': 100, 'videos.insert': 100 },
  },
  webhooks: {
    // YouTube Data API has no push webhooks. Pub/Sub push (PubSubHubbub) exists for public
    // channel upload notifications but is a different, unauthenticated mechanism out of scope
    // for this connector; every resource here is reconciled by polling only.
    supported: false,
    verification: 'none',
    resources: [],
    replayable: false,
  },
  constraints: [
    "search.list is banned from routine sync paths — each playlistItems.list call on the channel's uploads playlist is used for video discovery instead",
    'search.list and videos.insert each sit in their own 100-calls/day cap, entirely separate from the 10,000-unit daily pool',
    'the daily unit pool resets at midnight Pacific time',
    'analytics (read:insights) declares the yt-analytics.readonly scope but this connector does not yet fetch YouTube Analytics data — deferred to a later phase',
  ],
  tierNotes:
    'Default project quota is 10,000 units/day; a quota increase can be requested in Google Cloud Console but the 100-calls/day search.list and videos.insert caps are fixed regardless of project tier.',
} satisfies ConnectorManifest);
