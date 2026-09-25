/**
 * Pure normalisation of Graph payloads into canonical entities (spec §7.2, §8.7). Strict
 * schemas: an unknown shape throws and core quarantines the raw row as SCHEMA_DRIFT. No I/O,
 * no clock — the 24-hour window is computed from the platform's own timestamps.
 *
 * Conversation ids: a DM thread is `dm:<customer id>` from both the poll (participants) and
 * the webhook (sender/recipient), so the two paths converge on one Conversation row. Comment
 * threads are `post:<post id>` / `media:<media id>`; mentions `mention:<object id>`.
 */
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import type {
  CanonicalEntity,
  CanonicalMessage,
  CanonicalPerson,
  NormalizeCtx,
  Platform,
} from '@nexus/connector-sdk';
import { META_KINDS } from './manifest.ts';

export const WINDOW_MS = 24 * 3600_000;

const idName = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    username: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();
const attachment = z
  .object({
    id: z.string().optional(),
    mime_type: z.string().optional(),
    name: z.string().optional(),
    size: z.number().optional(),
    image_data: z
      .object({
        url: z.string(),
        preview_url: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      })
      .optional(),
    file_url: z.string().optional(),
    video_data: z.object({ url: z.string() }).optional(),
  })
  .passthrough();

// ── Facebook ──
const fbConversationSchema = z
  .object({
    id: z.string(),
    updated_time: z.string(),
    participants: z.object({ data: z.array(idName) }),
    snippet: z.string().optional(),
    message_count: z.number().optional(),
    unread_count: z.number().optional(),
    link: z.string().optional(),
  })
  .passthrough();
const fbMessageSchema = z
  .object({
    id: z.string(),
    message: z.string().default(''),
    created_time: z.string(),
    from: idName,
    to: z.object({ data: z.array(idName) }).optional(),
    attachments: z.object({ data: z.array(attachment) }).optional(),
    conversationId: z.string().optional(),
  })
  .passthrough();
const fbPostSchema = z
  .object({
    id: z.string(),
    message: z.string().optional(),
    story: z.string().optional(),
    created_time: z.string(),
    permalink_url: z.string().optional(),
    from: idName.optional(),
    full_picture: z.string().optional(),
  })
  .passthrough();
const fbCommentSchema = z
  .object({
    id: z.string(),
    message: z.string().default(''),
    created_time: z.string(),
    from: idName.optional(),
    parent: z.object({ id: z.string() }).optional(),
    is_hidden: z.boolean().optional(),
    permalink_url: z.string().optional(),
    postId: z.string().optional(),
    attachment: z.unknown().optional(),
  })
  .passthrough();
const fbMentionSchema = z
  .object({
    id: z.string(),
    message: z.string().optional(),
    created_time: z.string(),
    from: idName.optional(),
    permalink_url: z.string().optional(),
  })
  .passthrough();
const fbReviewSchema = z
  .object({
    id: z.string().optional(),
    reviewer: idName.optional(),
    rating: z.number().optional(),
    recommendation_type: z.enum(['positive', 'negative']).optional(),
    review_text: z.string().optional(),
    created_time: z.string(),
    open_graph_story: z.object({ id: z.string() }).optional(),
  })
  .passthrough();
const fbLeadSchema = z
  .object({
    id: z.string(),
    created_time: z.string(),
    form_id: z.string().optional(),
    formName: z.string().optional(),
    ad_id: z.string().optional(),
    adset_id: z.string().optional(),
    campaign_id: z.string().optional(),
    field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
  })
  .passthrough();
const fbLeadgenEventSchema = z
  .object({
    leadgen_id: z.string(),
    form_id: z.string().optional(),
    page_id: z.string().optional(),
    ad_id: z.string().optional(),
    adgroup_id: z.string().optional(),
    created_time: z.number().optional(),
  })
  .passthrough();
const fbInsightSchema = z
  .object({
    name: z.string(),
    period: z.string(),
    values: z.array(
      z.object({
        value: z.union([z.number(), z.record(z.string(), z.number())]),
        end_time: z.string().optional(),
      }),
    ),
    id: z.string().optional(),
    subjectId: z.string(),
  })
  .passthrough();
const messagingEventSchema = z
  .object({
    sender: z.object({ id: z.string() }),
    recipient: z.object({ id: z.string() }),
    timestamp: z.number(),
    message: z
      .object({
        mid: z.string(),
        text: z.string().optional(),
        is_echo: z.boolean().optional(),
        attachments: z
          .array(
            z.object({
              type: z.string(),
              payload: z.object({ url: z.string().optional() }).passthrough(),
            }),
          )
          .optional(),
      })
      .optional(),
    postback: z
      .object({
        mid: z.string().optional(),
        title: z.string().optional(),
        payload: z.string().optional(),
      })
      .optional(),
    entryId: z.string(),
  })
  .passthrough();
const feedChangeSchema = z
  .object({
    item: z.string(),
    verb: z.string(),
    comment_id: z.string().optional(),
    post_id: z.string().optional(),
    parent_id: z.string().optional(),
    message: z.string().optional(),
    created_time: z.number().optional(),
    from: idName.optional(),
    entryId: z.string(),
  })
  .passthrough();

// ── Instagram ──
const igMediaSchema = z
  .object({
    id: z.string(),
    caption: z.string().optional(),
    timestamp: z.string(),
    permalink: z.string().optional(),
    media_type: z.string().optional(),
    media_url: z.string().optional(),
    like_count: z.number().optional(),
    comments_count: z.number().optional(),
    username: z.string().optional(),
    owner: z.object({ id: z.string() }).optional(),
  })
  .passthrough();
const igCommentSchema = z
  .object({
    id: z.string(),
    text: z.string().default(''),
    timestamp: z.string(),
    username: z.string().optional(),
    from: idName.optional(),
    hidden: z.boolean().optional(),
    mediaId: z.string().optional(),
    parentId: z.string().optional(),
    like_count: z.number().optional(),
  })
  .passthrough();
const igMentionSchema = z
  .object({
    id: z.string(),
    caption: z.string().optional(),
    username: z.string().optional(),
    timestamp: z.string(),
    permalink: z.string().optional(),
    media_type: z.string().optional(),
    comment_id: z.string().optional(),
    text: z.string().optional(),
    owner: z.object({ id: z.string() }).optional(),
  })
  .passthrough();
const igDemographicSchema = z
  .object({
    name: z.string(),
    period: z.string(),
    subjectId: z.string(),
    total_value: z
      .object({
        breakdowns: z.array(
          z.object({
            dimension_keys: z.array(z.string()),
            results: z.array(
              z.object({ dimension_values: z.array(z.string()), value: z.number() }),
            ),
          }),
        ),
      })
      .optional(),
    values: z
      .array(
        z.object({
          value: z.union([z.number(), z.record(z.string(), z.number())]),
          end_time: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const date = (s: string | number): Date => {
  const d = typeof s === 'number' ? new Date(s < 1e12 ? s * 1000 : s) : new Date(s);
  if (Number.isNaN(d.getTime()))
    throw new NexusError('SCHEMA_DRIFT', { message: `unparseable timestamp ${String(s)}` });
  return d;
};

function person(
  platform: Platform,
  p: { id: string; name?: string; username?: string; email?: string },
  at: Date,
  profileBase: string,
): CanonicalPerson {
  return {
    kind: 'person',
    platform,
    externalId: p.id,
    occurredAt: at,
    sourceUrl: null,
    raw: p,
    handle: p.username ?? null,
    displayName: p.name ?? p.username ?? null,
    avatarUrl: null,
    profileUrl: p.username ? `${profileBase}/${p.username}` : null,
    ...(p.email ? { email: p.email } : {}),
  };
}

function dmMessage(
  platform: Platform,
  m: z.infer<typeof fbMessageSchema>,
  ctx: NormalizeCtx,
  conversationExternalId: string,
  link: string | null,
): CanonicalMessage {
  const at = date(m.created_time);
  const inbound = m.from.id !== ctx.accountExternalId;
  return {
    kind: 'message',
    platform,
    externalId: m.id,
    occurredAt: at,
    sourceUrl: link,
    raw: m,
    parentExternalId: null,
    rootExternalId: null,
    conversationExternalId,
    messageType: 'dm',
    direction: inbound ? 'inbound' : 'outbound',
    authorExternalId: m.from.id,
    recipientExternalIds: m.to?.data.map((t) => t.id),
    body: m.message,
    attachments: (m.attachments?.data ?? [])
      .map((a) => ({
        type: a.video_data
          ? ('video' as const)
          : a.image_data
            ? ('image' as const)
            : ('file' as const),
        url: a.video_data?.url ?? a.image_data?.url ?? a.file_url ?? '',
        mimeType: a.mime_type,
        name: a.name,
        sizeBytes: a.size,
        externalId: a.id,
      }))
      .filter((a) => a.url),
    sentAt: at,
    ...(inbound ? { replyWindowExpiresAt: new Date(at.getTime() + WINDOW_MS) } : {}),
  };
}

/** Customer participant of a DM thread = every participant that is not the connected account. */
function customerOf(participants: { id: string }[], accountId: string): string | null {
  return participants.find((p) => p.id !== accountId)?.id ?? null;
}

export function normalizeMeta(kind: string, raw: unknown, ctx: NormalizeCtx): CanonicalEntity[] {
  const platform = ctx.platform;
  const profileBase =
    platform === 'INSTAGRAM' ? 'https://www.instagram.com' : 'https://www.facebook.com';
  switch (kind) {
    case META_KINDS.fbConversation:
    case META_KINDS.igConversation: {
      const c = fbConversationSchema.parse(raw);
      const customer = customerOf(c.participants.data, ctx.accountExternalId);
      if (!customer)
        throw new NexusError('SCHEMA_DRIFT', {
          message: 'conversation without a customer participant',
        });
      const updated = date(c.updated_time);
      const conv: CanonicalEntity = {
        kind: 'conversation',
        platform,
        externalId: `dm:${customer}`,
        occurredAt: updated,
        sourceUrl: c.link ? `https://www.facebook.com${c.link}` : null,
        raw: c,
        conversationType: 'dm',
        participants: c.participants.data.map((p) => ({
          externalId: p.id,
          handle: p.username ?? null,
          displayName: p.name ?? null,
          role: p.id === ctx.accountExternalId ? ('owner' as const) : ('customer' as const),
        })),
        subject: c.snippet ?? null,
        status: 'open',
        lastMessageAt: updated,
        messageCount: c.message_count,
        unreadCount: c.unread_count,
        replyWindowExpiresAt: null,
        rootExternalId: null,
      };
      const cust = c.participants.data.find((p) => p.id === customer)!;
      return [person(platform, cust, updated, profileBase), conv];
    }
    case META_KINDS.fbMessage:
    case META_KINDS.igMessage: {
      const m = fbMessageSchema.parse(raw);
      const others = [m.from, ...(m.to?.data ?? [])].filter((p) => p.id !== ctx.accountExternalId);
      const customer = others[0];
      if (!customer)
        throw new NexusError('SCHEMA_DRIFT', { message: 'message without a customer party' });
      const msg = dmMessage(platform, m, ctx, `dm:${customer.id}`, null);
      return m.from.id === ctx.accountExternalId
        ? [msg]
        : [person(platform, customer, msg.sentAt, profileBase), msg];
    }
    case META_KINDS.fbMessageEvent:
    case META_KINDS.igMessageEvent: {
      const e = messagingEventSchema.parse(raw);
      const at = date(e.timestamp);
      const echo = e.message?.is_echo === true;
      const customer = echo ? e.recipient.id : e.sender.id;
      const externalId =
        e.message?.mid ?? e.postback?.mid ?? `postback:${e.sender.id}:${e.timestamp}`;
      const body =
        e.message?.text ??
        (e.postback ? `[postback] ${e.postback.title ?? e.postback.payload ?? ''}` : '');
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId,
        occurredAt: at,
        sourceUrl: null,
        raw: e,
        parentExternalId: null,
        rootExternalId: null,
        conversationExternalId: `dm:${customer}`,
        messageType: 'dm',
        direction: echo ? 'outbound' : 'inbound',
        authorExternalId: e.sender.id,
        recipientExternalIds: [e.recipient.id],
        body,
        attachments: (e.message?.attachments ?? [])
          .filter((a) => a.payload.url)
          .map((a) => ({
            type: (['image', 'video', 'audio', 'file'].includes(a.type) ? a.type : 'other') as
              'image' | 'video' | 'audio' | 'file' | 'other',
            url: a.payload.url!,
          })),
        sentAt: at,
        ...(echo ? {} : { replyWindowExpiresAt: new Date(at.getTime() + WINDOW_MS) }),
      };
      const conv: CanonicalEntity = {
        kind: 'conversation',
        platform,
        externalId: `dm:${customer}`,
        occurredAt: at,
        sourceUrl: null,
        raw: { derivedFrom: 'messaging_event', customer },
        conversationType: 'dm',
        participants: [
          { externalId: ctx.accountExternalId, handle: null, displayName: null, role: 'owner' },
          { externalId: customer, handle: null, displayName: null, role: 'customer' },
        ],
        subject: null,
        status: 'open',
        lastMessageAt: at,
        replyWindowExpiresAt: echo ? null : new Date(at.getTime() + WINDOW_MS),
        rootExternalId: null,
      };
      return echo ? [conv, msg] : [person(platform, { id: customer }, at, profileBase), conv, msg];
    }
    case META_KINDS.fbPost: {
      const p = fbPostSchema.parse(raw);
      const at = date(p.created_time);
      return [
        {
          kind: 'post',
          platform,
          externalId: p.id,
          occurredAt: at,
          sourceUrl: p.permalink_url ?? null,
          raw: p,
          parentExternalId: null,
          rootExternalId: null,
          authorExternalId: p.from?.id ?? ctx.accountExternalId,
          postType: 'original',
          mediaType: p.full_picture ? 'image' : 'text',
          body: p.message ?? p.story ?? '',
          media: p.full_picture ? [{ type: 'image', url: p.full_picture }] : [],
          publishedAt: at,
        },
      ];
    }
    case META_KINDS.fbComment: {
      const c = fbCommentSchema.parse(raw);
      const at = date(c.created_time);
      const post = c.postId ?? c.id.split('_')[0] ?? c.id;
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId: c.id,
        occurredAt: at,
        sourceUrl: c.permalink_url ?? null,
        raw: c,
        parentExternalId: c.parent?.id ?? null,
        rootExternalId: post,
        conversationExternalId: `post:${post}`,
        messageType: c.parent ? 'reply' : 'comment',
        direction: c.from?.id === ctx.accountExternalId ? 'outbound' : 'inbound',
        authorExternalId: c.from?.id ?? 'unknown',
        body: c.message,
        attachments: [],
        sentAt: at,
        ...(c.is_hidden ? { isHidden: true } : {}),
      };
      return c.from && c.from.id !== ctx.accountExternalId
        ? [person(platform, c.from, at, profileBase), msg]
        : [msg];
    }
    case META_KINDS.fbFeedChange: {
      const f = feedChangeSchema.parse(raw);
      if (f.item !== 'comment' || !f.comment_id) return [];
      const at = f.created_time ? date(f.created_time) : ctx.fetchedAt;
      const post = f.post_id ?? f.parent_id ?? 'unknown';
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId: f.comment_id,
        occurredAt: at,
        sourceUrl: null,
        raw: f,
        parentExternalId: f.parent_id && f.parent_id !== f.post_id ? f.parent_id : null,
        rootExternalId: post,
        conversationExternalId: `post:${post}`,
        messageType: 'comment',
        direction: f.from?.id === ctx.accountExternalId ? 'outbound' : 'inbound',
        authorExternalId: f.from?.id ?? 'unknown',
        body: f.message ?? '',
        attachments: [],
        sentAt: at,
        ...(f.verb === 'remove' ? { isDeleted: true } : {}),
        ...(f.verb === 'hide' ? { isHidden: true } : {}),
      };
      return f.from && f.from.id !== ctx.accountExternalId
        ? [person(platform, f.from, at, profileBase), msg]
        : [msg];
    }
    case META_KINDS.fbMention: {
      const m = fbMentionSchema.parse(raw);
      const at = date(m.created_time);
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId: m.id,
        occurredAt: at,
        sourceUrl: m.permalink_url ?? null,
        raw: m,
        parentExternalId: null,
        rootExternalId: m.id,
        conversationExternalId: `mention:${m.id}`,
        messageType: 'mention',
        direction: 'inbound',
        authorExternalId: m.from?.id ?? 'unknown',
        body: m.message ?? '',
        attachments: [],
        sentAt: at,
      };
      return m.from ? [person(platform, m.from, at, profileBase), msg] : [msg];
    }
    case META_KINDS.fbReview: {
      const r = fbReviewSchema.parse(raw);
      const at = date(r.created_time);
      const id = r.open_graph_story?.id ?? r.id ?? `${r.reviewer?.id ?? 'anon'}:${r.created_time}`;
      const review: CanonicalEntity = {
        kind: 'review',
        platform,
        externalId: id,
        occurredAt: at,
        sourceUrl: null,
        raw: r,
        authorExternalId: r.reviewer?.id ?? null,
        authorDisplayName: r.reviewer?.name ?? null,
        rating: r.rating ?? null,
        maxRating: 5,
        ...(r.recommendation_type ? { recommends: r.recommendation_type === 'positive' } : {}),
        body: r.review_text ?? '',
        reviewedAt: at,
        locationExternalId: ctx.accountExternalId,
        reply: null,
      };
      return r.reviewer ? [person(platform, r.reviewer, at, profileBase), review] : [review];
    }
    case META_KINDS.fbLead: {
      const l = fbLeadSchema.parse(raw);
      const at = date(l.created_time);
      const field = (n: string) => l.field_data.find((f) => f.name === n)?.values[0];
      const phone = field('phone_number');
      const email = field('email');
      return [
        {
          kind: 'lead',
          platform,
          externalId: l.id,
          occurredAt: at,
          sourceUrl: null,
          raw: l,
          source: 'lead_form',
          formExternalId: l.form_id,
          formName: l.formName,
          submittedAt: at,
          fields: l.field_data.map((f) => ({ name: f.name, value: f.values.join(', ') || null })),
          fullName: field('full_name'),
          ...(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { email } : {}),
          ...(phone && /^\+[1-9]\d{1,14}$/.test(phone) ? { phone } : {}),
          campaignExternalId: l.campaign_id,
          adSetExternalId: l.adset_id,
          adExternalId: l.ad_id,
        },
      ];
    }
    case META_KINDS.fbLeadgenEvent: {
      const e = fbLeadgenEventSchema.parse(raw);
      const at = e.created_time ? date(e.created_time) : ctx.fetchedAt;
      return [
        {
          kind: 'lead',
          platform,
          externalId: e.leadgen_id,
          occurredAt: at,
          sourceUrl: null,
          raw: e,
          source: 'lead_form',
          formExternalId: e.form_id,
          submittedAt: at,
          fields: [],
          adExternalId: e.ad_id,
        },
      ];
    }
    case META_KINDS.fbInsight:
    case META_KINDS.igInsight: {
      const i = fbInsightSchema.parse(raw);
      const granularity =
        i.period === 'day'
          ? 'day'
          : i.period === 'week'
            ? 'week'
            : i.period === 'days_28' || i.period === 'month'
              ? 'month'
              : 'lifetime';
      return i.values.flatMap((v) => {
        const end = v.end_time ? date(v.end_time) : ctx.fetchedAt;
        const start = new Date(
          end.getTime() -
            (granularity === 'day'
              ? 86_400_000
              : granularity === 'week'
                ? 7 * 86_400_000
                : granularity === 'month'
                  ? 28 * 86_400_000
                  : 0),
        );
        const subjectKind = platform === 'INSTAGRAM' ? 'account' : 'page';
        if (typeof v.value === 'number') {
          return [
            {
              kind: 'metric' as const,
              platform,
              externalId: `${i.subjectId}:${i.name}:${i.period}:${end.toISOString()}`,
              occurredAt: end,
              sourceUrl: null,
              raw: { ...i, values: [v] },
              subjectKind,
              subjectExternalId: i.subjectId,
              metric: i.name,
              value: v.value,
              period: { start, end, granularity },
            },
          ];
        }
        return Object.entries(v.value).map(([dim, value]) => ({
          kind: 'metric' as const,
          platform,
          externalId: `${i.subjectId}:${i.name}:${i.period}:${end.toISOString()}:${dim}`,
          occurredAt: end,
          sourceUrl: null,
          raw: { ...i, values: [v] },
          subjectKind,
          subjectExternalId: i.subjectId,
          metric: i.name,
          value,
          period: { start, end, granularity },
          dimensions: { key: dim },
        }));
      });
    }
    case META_KINDS.igDemographic: {
      const d = igDemographicSchema.parse(raw);
      const at = ctx.fetchedAt;
      const out: CanonicalEntity[] = [];
      for (const b of d.total_value?.breakdowns ?? []) {
        for (const r of b.results) {
          const dimensions = Object.fromEntries(
            b.dimension_keys.map((k, i) => [k, r.dimension_values[i] ?? '']),
          );
          out.push({
            kind: 'metric',
            platform,
            externalId: `${d.subjectId}:${d.name}:${Object.values(dimensions).join('|')}`,
            occurredAt: at,
            sourceUrl: null,
            raw: { name: d.name, breakdown: b.dimension_keys, result: r },
            subjectKind: 'account',
            subjectExternalId: d.subjectId,
            metric: d.name,
            value: r.value,
            period: { start: at, end: at, granularity: 'lifetime' },
            dimensions,
          });
        }
      }
      return out;
    }
    case META_KINDS.igMedia: {
      const m = igMediaSchema.parse(raw);
      const at = date(m.timestamp);
      const mediaType =
        m.media_type === 'VIDEO'
          ? 'video'
          : m.media_type === 'CAROUSEL_ALBUM'
            ? 'carousel'
            : m.media_type === 'REELS'
              ? 'reel'
              : 'image';
      return [
        {
          kind: 'post',
          platform,
          externalId: m.id,
          occurredAt: at,
          sourceUrl: m.permalink ?? null,
          raw: m,
          parentExternalId: null,
          rootExternalId: null,
          authorExternalId: m.owner?.id ?? ctx.accountExternalId,
          postType: 'original',
          mediaType,
          body: m.caption ?? '',
          media: m.media_url
            ? [
                {
                  type: mediaType === 'video' || mediaType === 'reel' ? 'video' : 'image',
                  url: m.media_url,
                },
              ]
            : [],
          publishedAt: at,
          stats: { likes: m.like_count, comments: m.comments_count },
        },
      ];
    }
    case META_KINDS.igComment: {
      const c = igCommentSchema.parse(raw);
      const at = date(c.timestamp);
      const media = c.mediaId ?? 'unknown';
      const authorId = c.from?.id ?? (c.username ? `ig:${c.username}` : 'unknown');
      const inbound = authorId !== ctx.accountExternalId;
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId: c.id,
        occurredAt: at,
        sourceUrl: null,
        raw: c,
        parentExternalId: c.parentId ?? null,
        rootExternalId: media,
        conversationExternalId: `media:${media}`,
        messageType: c.parentId ? 'reply' : 'comment',
        direction: inbound ? 'inbound' : 'outbound',
        authorExternalId: authorId,
        body: c.text,
        attachments: [],
        sentAt: at,
        ...(c.hidden ? { isHidden: true } : {}),
      };
      return inbound && authorId !== 'unknown'
        ? [
            person(
              platform,
              { id: authorId, username: c.username ?? c.from?.username, name: c.from?.name },
              at,
              profileBase,
            ),
            msg,
          ]
        : [msg];
    }
    case META_KINDS.igMention: {
      const m = igMentionSchema.parse(raw);
      const at = date(m.timestamp);
      const authorId = m.owner?.id ?? (m.username ? `ig:${m.username}` : 'unknown');
      const msg: CanonicalMessage = {
        kind: 'message',
        platform,
        externalId: m.comment_id ?? m.id,
        occurredAt: at,
        sourceUrl: m.permalink ?? null,
        raw: m,
        parentExternalId: null,
        rootExternalId: m.id,
        conversationExternalId: `mention:${m.id}`,
        messageType: 'mention',
        direction: 'inbound',
        authorExternalId: authorId,
        body: m.text ?? m.caption ?? '',
        attachments: [],
        sentAt: at,
      };
      return authorId !== 'unknown'
        ? [person(platform, { id: authorId, username: m.username }, at, profileBase), msg]
        : [msg];
    }
    default:
      throw new NexusError('SCHEMA_DRIFT', { message: `unknown kind ${kind}` });
  }
}
