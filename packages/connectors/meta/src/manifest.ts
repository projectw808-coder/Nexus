/**
 * The Meta manifest (spec §8.1). The Graph API version is pinned HERE and nowhere else in the
 * connector; every request path is built from `manifest.apiVersion`. Figures reflect the
 * platform as of September 2026 (v26.0 released 29 Jul 2026) — verify against Meta's live
 * changelog when upgrading; the version monitor flags sunsets inside 180 days.
 */
import {
  connectorManifestSchema,
  type ConnectorManifest,
  type Lane,
  type ResourceDescriptor,
} from '@nexus/connector-sdk';

export const META_API_VERSION = 'v26.0';

/** `ExternalObject.kind` values this connector yields. */
export const META_KINDS = {
  fbConversation: 'fb_conversation',
  fbMessage: 'fb_message',
  fbPost: 'fb_post',
  fbComment: 'fb_comment',
  fbMention: 'fb_mention',
  fbReview: 'fb_review',
  fbLead: 'fb_lead',
  fbInsight: 'fb_insight',
  fbMessageEvent: 'fb_message_event',
  fbFeedChange: 'fb_feed_change',
  fbLeadgenEvent: 'fb_leadgen_event',
  igConversation: 'ig_conversation',
  igMessage: 'ig_message',
  igMedia: 'ig_media',
  igComment: 'ig_comment',
  igMention: 'ig_mention',
  igInsight: 'ig_insight',
  igDemographic: 'ig_demographic',
  igMessageEvent: 'ig_message_event',
} as const;
export type MetaKind = (typeof META_KINDS)[keyof typeof META_KINDS];

const lanes = (): ResourceDescriptor['laneHints'] => ({
  defaultLane: 'delta',
  allowedLanes: ['delta', 'backfill', 'webhook', 'interactive'] as Lane[],
});

const fbResources: ResourceDescriptor[] = [
  {
    id: 'fb.conversations',
    displayName: 'Page messages (Messenger)',
    kinds: [META_KINDS.fbConversation, META_KINDS.fbMessage, META_KINDS.fbMessageEvent],
    defaultIntervalSeconds: 60,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'fb.comments',
    displayName: 'Post comments',
    kinds: [META_KINDS.fbPost, META_KINDS.fbComment, META_KINDS.fbFeedChange],
    defaultIntervalSeconds: 300,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'fb.mentions',
    displayName: 'Mentions & tags',
    kinds: [META_KINDS.fbMention],
    defaultIntervalSeconds: 300,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: false,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'fb.reviews',
    displayName: 'Reviews & recommendations',
    kinds: [META_KINDS.fbReview],
    defaultIntervalSeconds: 3600,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: false,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'fb.leads',
    displayName: 'Lead form submissions',
    kinds: [META_KINDS.fbLead, META_KINDS.fbLeadgenEvent],
    defaultIntervalSeconds: 300,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 2,
    laneHints: lanes(),
  },
  {
    id: 'fb.insights',
    displayName: 'Page insights',
    kinds: [META_KINDS.fbInsight],
    defaultIntervalSeconds: 3600,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: false,
    costPerPage: 1,
    laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
  },
];

const igResources: ResourceDescriptor[] = [
  {
    id: 'ig.dms',
    displayName: 'Instagram DMs',
    kinds: [META_KINDS.igConversation, META_KINDS.igMessage, META_KINDS.igMessageEvent],
    defaultIntervalSeconds: 60,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'ig.comments',
    displayName: 'Post & Reel comments',
    kinds: [META_KINDS.igMedia, META_KINDS.igComment],
    defaultIntervalSeconds: 300,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'ig.mentions',
    displayName: 'Mentions & tags',
    kinds: [META_KINDS.igMention],
    defaultIntervalSeconds: 300,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: true,
    costPerPage: 1,
    laneHints: lanes(),
  },
  {
    id: 'ig.insights',
    displayName: 'Account & media insights',
    kinds: [META_KINDS.igInsight],
    defaultIntervalSeconds: 3600,
    defaultEnabled: true,
    supportsBackfill: true,
    supportsWebhook: false,
    costPerPage: 1,
    laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
  },
  {
    id: 'ig.followers',
    displayName: 'Follower demographics',
    kinds: [META_KINDS.igDemographic],
    defaultIntervalSeconds: 86_400,
    defaultEnabled: false,
    supportsBackfill: false,
    supportsWebhook: false,
    costPerPage: 1,
    laneHints: { defaultLane: 'delta', allowedLanes: ['delta'] },
    warning: 'Needs instagram_manage_insights and an account with at least 100 followers.',
  },
];

export const FB_RESOURCE_IDS = fbResources.map((r) => r.id);
export const IG_RESOURCE_IDS = igResources.map((r) => r.id);

export const metaManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'FACEBOOK',
  displayName: 'Meta (Facebook Pages + Instagram)',
  apiVersion: META_API_VERSION,
  docsUrl: 'https://developers.facebook.com/docs/graph-api/',
  authKind: 'oauth2',
  scopes: [
    {
      id: 'pages_show_list',
      plainLanguage: 'See the list of Pages you manage',
      requiredFor: ['read:profile'],
      sensitive: false,
    },
    {
      id: 'pages_read_engagement',
      plainLanguage: 'Read posts, comments and reactions on your Pages',
      requiredFor: ['read:comments', 'read:posts', 'read:mentions', 'read:reviews'],
      sensitive: true,
    },
    {
      id: 'pages_manage_metadata',
      plainLanguage: 'Subscribe your Pages to real-time updates (webhooks)',
      requiredFor: [],
      sensitive: true,
    },
    {
      id: 'pages_messaging',
      plainLanguage: 'Read and reply to Messenger conversations on your Pages',
      requiredFor: ['read:messages', 'write:reply_dm'],
      sensitive: true,
    },
    {
      id: 'pages_manage_engagement',
      plainLanguage: 'Reply to, hide and delete comments on your Pages',
      requiredFor: ['write:reply_comment', 'write:hide_comment', 'write:delete_comment'],
      sensitive: true,
    },
    {
      id: 'instagram_basic',
      plainLanguage: 'See your Instagram professional account and its media',
      requiredFor: ['read:posts'],
      sensitive: false,
    },
    {
      id: 'instagram_manage_messages',
      plainLanguage: 'Read and reply to Instagram DMs',
      requiredFor: ['read:messages', 'write:reply_dm'],
      sensitive: true,
    },
    {
      id: 'instagram_manage_comments',
      plainLanguage: 'Read, reply to and hide Instagram comments',
      requiredFor: [
        'read:comments',
        'read:mentions',
        'write:reply_comment',
        'write:hide_comment',
        'write:delete_comment',
      ],
      sensitive: true,
    },
    {
      id: 'instagram_manage_insights',
      plainLanguage: 'Read Instagram insights and follower demographics',
      requiredFor: ['read:insights', 'read:followers'],
      sensitive: true,
    },
    {
      id: 'leads_retrieval',
      plainLanguage: 'Retrieve lead form submissions from your Pages',
      requiredFor: ['read:leads'],
      sensitive: true,
    },
    {
      id: 'business_management',
      plainLanguage: 'Access the Business Manager assets your Pages belong to',
      requiredFor: [],
      sensitive: true,
    },
  ],
  resources: [...fbResources, ...igResources],
  capabilities: [
    'read:profile',
    'read:messages',
    'read:comments',
    'read:mentions',
    'read:posts',
    'read:insights',
    'read:leads',
    'read:reviews',
    'read:followers',
    'write:reply_dm',
    'write:reply_comment',
    'write:hide_comment',
    'write:delete_comment',
  ],
  quota: {
    kind: 'rolling_hour',
    limit: 4800,
    headerNames: ['x-app-usage', 'x-business-use-case-usage', 'x-page-usage'],
    backoffAtFraction: 0.8,
  },
  webhooks: {
    supported: true,
    verification: 'hmac_sha256',
    resources: [
      'fb.conversations',
      'fb.comments',
      'fb.leads',
      'ig.dms',
      'ig.comments',
      'ig.mentions',
    ],
    replayable: false,
  },
  constraints: [
    "Standard messaging must be sent within 24 hours of the customer's last message; outside the window only tagged messages are allowed.",
    'A call to an expired Graph API version is served silently from the next-oldest version — the served version is asserted on every response.',
    'Advanced access to the sensitive scopes requires App Review and Business Verification; until then only accounts with a role on the app return data.',
    'Instagram webhooks are subscribed at the app level in the Meta dashboard; Page fields are subscribed per Page on connect.',
    "Page tokens are issued per Page and never expire while the user's long-lived token is valid; the user token is re-exchanged on a schedule.",
  ],
  tierNotes:
    'A Meta app in Live mode with Facebook Login for Business; Advanced Access on the messaging, engagement, comments, insights and leads scopes (App Review + Business Verification). Standard Access works for testing with app roles only.',
  apiVersionHeader: 'facebook-api-version',
  messagingWindowHours: 24,
} satisfies ConnectorManifest);
