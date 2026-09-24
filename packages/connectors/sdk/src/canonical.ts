import { z } from 'zod';
import { platformSchema } from './platform.ts';

// ─── Shared building blocks ─────────────────────────────────────────────────

/** E.164: leading `+`, 2–15 digits, no leading zero. */
export const e164Schema = z.string().regex(/^\+[1-9]\d{1,14}$/, 'phone must be E.164');

/** IANA time zone name (`Europe/Berlin`, `America/Los_Angeles`, `UTC`). */
export const timezoneSchema = z.string().regex(/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/);

/** ISO-4217 currency code. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

/**
 * Media or file attached to a message or post. `url` is the platform's
 * original (usually expiring CDN) URL kept for provenance; the materializer
 * fetches it to S3 and stores the durable location elsewhere (§8.7).
 */
export const attachmentSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file', 'link', 'sticker', 'gif', 'other']),
  url: z.string().min(1),
  mimeType: z.string().optional(),
  name: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Platform-side id, when the platform issues one. */
  externalId: z.string().optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * The fields every canonical entity carries (spec §7.2).
 *
 * - `externalId` is the platform's stable id, NOT a handle (§8.7).
 * - `occurredAt` is UTC; the platform's original timestamp string stays in `raw`.
 * - `sourceUrl` is a deep link to the object on the platform, or `null`.
 * - `raw` is the untouched platform payload (or the slice this entity was cut from).
 */
export const canonicalBaseSchema = z.object({
  platform: platformSchema,
  externalId: z.string().min(1),
  occurredAt: z.coerce.date(),
  sourceUrl: z.url().nullable(),
  raw: z.unknown(),
});

export type CanonicalBase = z.infer<typeof canonicalBaseSchema>;

/**
 * Comment/reply threading per §8.7: a comment on IG, a reply on X, a comment
 * on YouTube and a comment on a LinkedIn share are the same canonical thing.
 * `parentExternalId` is the direct parent; `rootExternalId` is the top of the
 * thread (the post, video or share). Both `null` on a top-level object.
 */
export const threadingSchema = z.object({
  parentExternalId: z.string().nullable(),
  rootExternalId: z.string().nullable(),
});

// ─── Person ─────────────────────────────────────────────────────────────────

export const canonicalPersonSchema = canonicalBaseSchema.extend({
  kind: z.literal('person'),
  /** Current handle; handles change — history lives in `raw` and identity keys on `externalId`. */
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  profileUrl: z.url().nullable(),
  email: z.email().optional(),
  phone: e164Schema.optional(),
  bio: z.string().optional(),
  /** BCP-47 tag (`en-GB`). */
  locale: z.string().optional(),
  timezone: timezoneSchema.optional(),
  followerCount: z.number().int().nonnegative().optional(),
  followingCount: z.number().int().nonnegative().optional(),
  isVerified: z.boolean().optional(),
  /** Links to a `CanonicalCompany.externalId` on the same platform, when the platform provides it. */
  companyExternalId: z.string().optional(),
});

export type CanonicalPerson = z.infer<typeof canonicalPersonSchema>;

// ─── Company ────────────────────────────────────────────────────────────────

export const canonicalCompanySchema = canonicalBaseSchema.extend({
  kind: z.literal('company'),
  name: z.string().min(1),
  handle: z.string().nullable(),
  /** Bare registrable domain (`acme.com`), the Tier-2 identity signal in §10. */
  domain: z.string().optional(),
  websiteUrl: z.url().optional(),
  logoUrl: z.url().nullable(),
  profileUrl: z.url().nullable(),
  description: z.string().optional(),
  industry: z.string().optional(),
  /** Platform-reported headcount bucket or number, as a string to preserve buckets like "51-200". */
  size: z.string().optional(),
  location: z.string().optional(),
  followerCount: z.number().int().nonnegative().optional(),
});

export type CanonicalCompany = z.infer<typeof canonicalCompanySchema>;

// ─── Conversation ───────────────────────────────────────────────────────────

export const conversationTypeSchema = z.enum([
  'dm',
  'comment_thread',
  'mention_thread',
  'email_thread',
  'review_thread',
  'other',
]);
export type ConversationType = z.infer<typeof conversationTypeSchema>;

export const participantSchema = z.object({
  externalId: z.string().min(1),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  /** `owner` is the connected account itself. */
  role: z.enum(['owner', 'customer', 'participant']),
});
export type Participant = z.infer<typeof participantSchema>;

export const canonicalConversationSchema = canonicalBaseSchema.extend({
  kind: z.literal('conversation'),
  conversationType: conversationTypeSchema,
  participants: z.array(participantSchema),
  subject: z.string().nullable(),
  status: z.enum(['open', 'closed', 'archived', 'unknown']),
  lastMessageAt: z.coerce.date().nullable(),
  messageCount: z.number().int().nonnegative().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  /**
   * When the platform's messaging window closes for the connected account
   * (Meta 24h rule, TikTok Business Messaging). `null` = no window applies.
   * Drives the live countdown in the composer and the `preflight()` block.
   */
  replyWindowExpiresAt: z.coerce.date().nullable(),
  /** For comment threads: the post/video/share the thread hangs off. */
  rootExternalId: z.string().nullable(),
});

export type CanonicalConversation = z.infer<typeof canonicalConversationSchema>;

// ─── Message ────────────────────────────────────────────────────────────────

export const messageTypeSchema = z.enum([
  'dm',
  'comment',
  'reply',
  'mention',
  'email',
  'review_reply',
  'other',
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const canonicalMessageSchema = canonicalBaseSchema.extend(threadingSchema.shape).extend({
  kind: z.literal('message'),
  conversationExternalId: z.string().min(1),
  messageType: messageTypeSchema,
  /** Relative to the connected account: `inbound` = someone wrote to us. */
  direction: z.enum(['inbound', 'outbound']),
  authorExternalId: z.string().min(1),
  recipientExternalIds: z.array(z.string()).optional(),
  body: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(attachmentSchema),
  sentAt: z.coerce.date(),
  editedAt: z.coerce.date().optional(),
  /** Set on every INBOUND message where a window rule applies (§8.1); the conversation inherits the latest. */
  replyWindowExpiresAt: z.coerce.date().optional(),
  /** Platform tombstone (X deletion events, hidden/deleted comments). Never drop locally; mark. */
  isDeleted: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  /** Idempotency echo: when this message is the result of one of our own `OutboundAction`s. */
  outboundActionId: z.string().optional(),
});

export type CanonicalMessage = z.infer<typeof canonicalMessageSchema>;

// ─── Post ───────────────────────────────────────────────────────────────────

export const canonicalPostSchema = canonicalBaseSchema.extend(threadingSchema.shape).extend({
  kind: z.literal('post'),
  authorExternalId: z.string().min(1),
  postType: z.enum(['original', 'reply', 'quote', 'repost', 'story']),
  mediaType: z.enum(['text', 'image', 'video', 'carousel', 'reel', 'short', 'link', 'other']),
  body: z.string(),
  bodyHtml: z.string().optional(),
  media: z.array(attachmentSchema),
  publishedAt: z.coerce.date(),
  editedAt: z.coerce.date().optional(),
  hashtags: z.array(z.string()).optional(),
  mentionedExternalIds: z.array(z.string()).optional(),
  /** Point-in-time counters as returned with the post; time series go to `CanonicalMetric`. */
  stats: z
    .object({
      likes: z.number().int().nonnegative().optional(),
      comments: z.number().int().nonnegative().optional(),
      shares: z.number().int().nonnegative().optional(),
      views: z.number().int().nonnegative().optional(),
      impressions: z.number().int().nonnegative().optional(),
      reach: z.number().int().nonnegative().optional(),
    })
    .optional(),
  isDeleted: z.boolean().optional(),
});

export type CanonicalPost = z.infer<typeof canonicalPostSchema>;

// ─── Engagement ─────────────────────────────────────────────────────────────

export const engagementTypeSchema = z.enum([
  'like',
  'share',
  'reaction',
  'view',
  'follow',
  'unfollow',
  'save',
]);
export type EngagementType = z.infer<typeof engagementTypeSchema>;

export const canonicalEngagementSchema = canonicalBaseSchema.extend({
  kind: z.literal('engagement'),
  engagementType: engagementTypeSchema,
  targetKind: z.enum(['post', 'message', 'account', 'comment']),
  targetExternalId: z.string().min(1),
  /** `null` when the platform only reports an aggregate (e.g. view counts). */
  actorExternalId: z.string().nullable(),
  /** Platform reaction label (`love`, `haha`, `👍`) when `engagementType` is `reaction`. */
  reactionType: z.string().optional(),
  /** Aggregate count when `actorExternalId` is `null`. */
  count: z.number().int().nonnegative().optional(),
});

export type CanonicalEngagement = z.infer<typeof canonicalEngagementSchema>;

// ─── Lead ───────────────────────────────────────────────────────────────────

export const leadFieldSchema = z.object({
  /** Platform field key (`full_name`, `custom_question_1`). */
  name: z.string().min(1),
  label: z.string().optional(),
  value: z.string().nullable(),
});
export type LeadField = z.infer<typeof leadFieldSchema>;

export const canonicalLeadSchema = canonicalBaseSchema.extend({
  kind: z.literal('lead'),
  source: z.enum(['lead_form', 'landing_page', 'message', 'other']),
  formExternalId: z.string().optional(),
  formName: z.string().optional(),
  submittedAt: z.coerce.date(),
  /** Every submitted field in order; the typed fields below are the connector's best extraction. */
  fields: z.array(leadFieldSchema),
  fullName: z.string().optional(),
  email: z.email().optional(),
  phone: e164Schema.optional(),
  companyName: z.string().optional(),
  /** Ad attribution when the platform provides it (Meta/LinkedIn/TikTok lead forms). */
  campaignExternalId: z.string().optional(),
  adSetExternalId: z.string().optional(),
  adExternalId: z.string().optional(),
  /** Consent captured on the form, needed for the §12 lawful-basis record. */
  consent: z
    .object({
      marketing: z.boolean().optional(),
      text: z.string().optional(),
    })
    .optional(),
});

export type CanonicalLead = z.infer<typeof canonicalLeadSchema>;

// ─── Review ─────────────────────────────────────────────────────────────────

export const canonicalReviewSchema = canonicalBaseSchema.extend({
  kind: z.literal('review'),
  authorExternalId: z.string().nullable(),
  authorDisplayName: z.string().nullable(),
  /** `null` for recommendation-style reviews without a star scale (Facebook). */
  rating: z.number().min(0).nullable(),
  maxRating: z.number().positive().default(5),
  /** Facebook "recommends / doesn't recommend". */
  recommends: z.boolean().optional(),
  title: z.string().optional(),
  body: z.string(),
  reviewedAt: z.coerce.date(),
  /** Google Business location, Facebook page, etc. */
  locationExternalId: z.string().optional(),
  reply: z
    .object({
      externalId: z.string().optional(),
      body: z.string(),
      repliedAt: z.coerce.date(),
    })
    .nullable(),
});

export type CanonicalReview = z.infer<typeof canonicalReviewSchema>;

// ─── Metric ─────────────────────────────────────────────────────────────────

export const metricGranularitySchema = z.enum(['lifetime', 'hour', 'day', 'week', 'month']);
export type MetricGranularity = z.infer<typeof metricGranularitySchema>;

export const canonicalMetricSchema = canonicalBaseSchema.extend({
  kind: z.literal('metric'),
  subjectKind: z.enum(['account', 'page', 'channel', 'post', 'video', 'campaign', 'offer', 'ad']),
  subjectExternalId: z.string().min(1),
  /** Metric name as the platform calls it (`impressions`, `reach`, `subscriberCount`, `epc`). */
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().optional(),
  period: z.object({
    start: z.coerce.date(),
    end: z.coerce.date(),
    granularity: metricGranularitySchema,
  }),
  /** Breakdown dimensions (`{ country: 'GB' }`, `{ age: '25-34', gender: 'f' }`). */
  dimensions: z.record(z.string(), z.string()).optional(),
});

export type CanonicalMetric = z.infer<typeof canonicalMetricSchema>;

// ─── Conversion (Keitaro §8.6 — the attribution spine) ──────────────────────

/**
 * Keitaro's standard conversion statuses. `lead` = unconfirmed payout,
 * `sale` = confirmed, `rejected` = cancelled (reverses revenue). User-defined
 * custom statuses are allowed as any other non-empty string.
 */
export const KEITARO_STANDARD_STATUSES = [
  'lead',
  'sale',
  'rejected',
  'registration',
  'deposit',
  'trash',
] as const;
export type StandardConversionStatus = (typeof KEITARO_STANDARD_STATUSES)[number];
export type ConversionStatus = StandardConversionStatus | (string & {});

export const conversionStatusSchema = z.custom<ConversionStatus>(
  (v) => typeof v === 'string' && v.length > 0,
  'conversion status must be a non-empty string',
);

export const SUB_ID_KEYS = [
  'sub_id_1',
  'sub_id_2',
  'sub_id_3',
  'sub_id_4',
  'sub_id_5',
  'sub_id_6',
  'sub_id_7',
  'sub_id_8',
  'sub_id_9',
  'sub_id_10',
  'sub_id_11',
  'sub_id_12',
  'sub_id_13',
  'sub_id_14',
  'sub_id_15',
  'sub_id_16',
  'sub_id_17',
  'sub_id_18',
  'sub_id_19',
  'sub_id_20',
  'sub_id_21',
  'sub_id_22',
  'sub_id_23',
  'sub_id_24',
  'sub_id_25',
  'sub_id_26',
  'sub_id_27',
  'sub_id_28',
  'sub_id_29',
  'sub_id_30',
] as const;
export type SubIdKey = (typeof SUB_ID_KEYS)[number];

/** Partial: only the sub_ids Keitaro populated need to be present. */
export const subIdsSchema = z.partialRecord(z.enum(SUB_ID_KEYS), z.string().nullable());
export type SubIds = z.infer<typeof subIdsSchema>;

const namedRefSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().nullable(),
});

/**
 * One conversion postback. `externalId` is Keitaro's `conversion_id`;
 * `occurredAt` is `postback_datetime`. Upsert key is `(connectionId, subid, tid)`
 * and `status` is a state machine (`lead → sale → rejected`) — the same key
 * arrives repeatedly and a `rejected` MUST reverse revenue it previously added.
 */
export const canonicalConversionSchema = canonicalBaseSchema.extend({
  kind: z.literal('conversion'),
  /** The click id — the join key to the click, the anonymous Identity and later channel events. */
  subid: z.string().min(1),
  /** Transaction id; lets one click carry several conversions without overwriting. Empty when Keitaro sent none. */
  tid: z.string(),
  status: conversionStatusSchema,
  /** Previous status if Keitaro reports it, so the transition can be recorded without a lookup. */
  previousStatus: conversionStatusSchema.nullable().optional(),
  /** May be NEGATIVE on a chargeback. Never clamp. */
  payout: z.number(),
  revenue: z.number().optional(),
  cost: z.number().optional(),
  currency: currencyCodeSchema,
  subIds: subIdsSchema,
  campaign: namedRefSchema.nullable(),
  source: namedRefSchema.nullable(),
  offer: namedRefSchema.nullable(),
  affiliateNetwork: namedRefSchema.nullable(),
  stream: namedRefSchema.nullable(),
  landing: namedRefSchema.nullable(),
  geo: z
    .object({
      /** ISO-3166-1 alpha-2. */
      country: z.string().length(2),
      region: z.string().optional(),
      city: z.string().optional(),
    })
    .nullable(),
  device: z
    .object({
      type: z.string().optional(),
      os: z.string().optional(),
      browser: z.string().optional(),
    })
    .nullable(),
  creative: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .nullable(),
  clickedAt: z.coerce.date().nullable(),
  postbackAt: z.coerce.date(),
});

export type CanonicalConversion = z.infer<typeof canonicalConversionSchema>;

// ─── Union ──────────────────────────────────────────────────────────────────

export const canonicalEntitySchema = z.discriminatedUnion('kind', [
  canonicalPersonSchema,
  canonicalCompanySchema,
  canonicalConversationSchema,
  canonicalMessageSchema,
  canonicalPostSchema,
  canonicalEngagementSchema,
  canonicalLeadSchema,
  canonicalReviewSchema,
  canonicalMetricSchema,
  canonicalConversionSchema,
]);

export type CanonicalEntity = z.infer<typeof canonicalEntitySchema>;
export type CanonicalKind = CanonicalEntity['kind'];

export const CANONICAL_KINDS = [
  'person',
  'company',
  'conversation',
  'message',
  'post',
  'engagement',
  'lead',
  'review',
  'metric',
  'conversion',
] as const satisfies readonly CanonicalKind[];

/** Look up an entity type by its discriminator. */
export type CanonicalEntityOf<K extends CanonicalKind> = Extract<CanonicalEntity, { kind: K }>;
