import { connectorManifestSchema, type ConnectorManifest } from '@nexus/connector-sdk';

export const KINDS = {
  video: 'tiktok_video',
  comment: 'tiktok_comment',
  dm: 'tiktok_dm',
  lead: 'tiktok_lead',
} as const;

/**
 * TikTok (spec Phase 8): ONE connector serving two distinct consoles behind
 * `TikTokConfig.provider`.
 *
 * - `'business'` (default): TikTok for Business — Business Account API (owned video list +
 *   metrics, comment moderation) and the Marketing API's Business Messaging v1.3 (DMs) and
 *   Lead Generation (webhook-fed form submissions). This is where the CRM value is.
 * - `'display'`: the public Display API — read-only content and profile data for whichever
 *   account authorized Login Kit. No messaging, no comment moderation, no leads, regardless of
 *   which scopes were granted; `connector.capabilities()` hard-filters these out for Display
 *   before scope-degradation is even applied (see `connector.ts`).
 *
 * The manifest below declares the UNION of every capability either provider could have; the
 * connector's `capabilities(ctx)` narrows it per `ctx.config.provider`.
 */
export const tiktokManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'TIKTOK',
  displayName: 'TikTok',
  apiVersion: 'v2',
  docsUrl: 'https://developers.tiktok.com/',
  authKind: 'oauth2',
  scopes: [
    {
      id: 'user.info.basic',
      plainLanguage: 'See your TikTok profile and follower count',
      requiredFor: ['read:profile', 'read:followers'],
      sensitive: false,
    },
    {
      id: 'video.list',
      plainLanguage: 'See the videos published by your account',
      requiredFor: ['read:posts'],
      sensitive: false,
    },
    {
      id: 'video.comment.list',
      plainLanguage: 'See comments people leave on your videos',
      requiredFor: ['read:comments'],
      sensitive: true,
    },
    {
      id: 'video.comment.manage',
      plainLanguage: 'Reply to, hide or delete comments on your videos',
      requiredFor: ['write:reply_comment', 'write:hide_comment', 'write:delete_comment'],
      sensitive: true,
    },
    {
      id: 'biz.dm.read',
      plainLanguage: 'See direct messages sent to your business account',
      requiredFor: ['read:messages'],
      sensitive: true,
    },
    {
      id: 'biz.dm.send',
      plainLanguage: 'Reply to direct messages as your business account',
      requiredFor: ['write:reply_dm'],
      sensitive: true,
    },
    {
      id: 'leads.retrieval',
      plainLanguage: 'Retrieve leads submitted through your Lead Generation forms',
      requiredFor: ['read:leads'],
      sensitive: true,
    },
  ],
  resources: [
    {
      id: 'tiktok.videos',
      displayName: 'Videos',
      kinds: [KINDS.video],
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
    {
      id: 'tiktok.comments',
      displayName: 'Video comments',
      kinds: [KINDS.comment],
      defaultIntervalSeconds: 300,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'interactive'] },
    },
    {
      id: 'tiktok.dms',
      displayName: 'Business direct messages',
      kinds: [KINDS.dm],
      defaultIntervalSeconds: 60,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: {
        defaultLane: 'delta',
        allowedLanes: ['delta', 'backfill', 'webhook', 'interactive'],
      },
      warning:
        'Business-only — never available on the Display provider. Replies are subject to the 48-hour Business Messaging window (see manifest.messagingWindowHours).',
    },
    {
      id: 'tiktok.leads',
      displayName: 'Lead Generation submissions',
      kinds: [KINDS.lead],
      defaultIntervalSeconds: 900,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'webhook'] },
      warning: 'Business-only — never available on the Display provider.',
    },
  ],
  capabilities: [
    'read:posts',
    'read:profile',
    'read:followers',
    'read:comments',
    'write:reply_comment',
    'write:hide_comment',
    'write:delete_comment',
    'read:messages',
    'write:reply_dm',
    'read:leads',
  ],
  // TikTok's Business/Marketing API rate limits vary by product and app tier and are not
  // cleanly published in one place; this is OUR conservative placeholder default (see
  // docs/connectors/tiktok.md §8), pending the customer's actual approved tier.
  quota: { kind: 'fixed_window', windowSeconds: 86_400, limit: 100_000 },
  webhooks: {
    supported: true,
    verification: 'hmac_sha256',
    resources: ['tiktok.dms', 'tiktok.leads'],
    replayable: false,
  },
  constraints: [
    'Business Messaging, comment moderation and Lead Generation are exclusive to the TikTok for Business provider — set config.provider: "display" for read-only public content access only; those capabilities never appear for Display, regardless of granted scopes.',
    'The video.comment.manage scope covers reply, hide AND delete — one grant covers all three comment-write actions.',
    "The 48-hour Business Messaging window (manifest.messagingWindowHours) is sourced from third-party integrator documentation (SleekFlow, Respond.io), not TikTok's own developer docs, because those docs were not directly accessible while building this connector — re-verify against TikTok's official Business Messaging documentation before relying on it in production.",
    'TikTok connections carry stricter data-retention expectations than most platforms — default new connections to a lower ConnectionSettings.retentionDays than the platform default (UI/connect-flow guidance; not enforced by this manifest).',
  ],
  tierNotes:
    'TikTok for Business (Business Account API, comment moderation, Business Messaging, Lead Generation) requires TikTok for Business app review and, for Lead Generation specifically, an approved Marketing API app. The Display API needs only standard Login Kit approval and never unlocks messaging, moderation or leads no matter what is approved.',
  // Meta mirrors this as messagingWindowHours: 24; TikTok Business Messaging's window is 48h
  // per third-party integrator docs (see the constraints entry above and docs §9).
  messagingWindowHours: 48,
  outboundLimits: { dm: 1000 },
  outboundAttachmentTypes: [],
} satisfies ConnectorManifest);
