/**
 * Meta webhooks (spec §8.1): `X-Hub-Signature-256` over the raw body with the app secret;
 * payloads `{ object: 'page' | 'instagram', entry: [{ id, time, messaging?: [...],
 * changes?: [{ field, value }] }] }` split into one envelope per event, no interpretation.
 * Topics: messages, messaging_postbacks, feed, comments, mentions, leadgen.
 */
import { z } from 'zod';
import { verifyHmacSha256, type WebhookEnvelope, type WebhookRequest } from '@nexus/connector-sdk';
import { META_KINDS } from './manifest.ts';

const bodySchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      messaging: z.array(z.record(z.string(), z.unknown())).optional(),
      changes: z
        .array(z.object({ field: z.string(), value: z.record(z.string(), z.unknown()) }))
        .optional(),
    }),
  ),
});

export function verifyMetaWebhook(req: WebhookRequest, appSecret: string): boolean {
  return verifyHmacSha256({
    rawBody: req.rawBody,
    secret: appSecret,
    signature: req.headers['x-hub-signature-256'],
    prefix: 'sha256=',
  });
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

export function parseMetaWebhook(req: WebhookRequest): WebhookEnvelope[] {
  const text =
    typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return [];
  const body = parsed.data;
  const platform =
    body.object === 'instagram' ? 'INSTAGRAM' : body.object === 'page' ? 'FACEBOOK' : null;
  if (!platform) return [];
  const out: WebhookEnvelope[] = [];
  for (const entry of body.entry) {
    const receivedAt = new Date(
      entry.time && entry.time < 1e12 ? entry.time * 1000 : (entry.time ?? Date.now()),
    );
    const hint = { platform, accountExternalId: entry.id } as const;
    for (const m of entry.messaging ?? []) {
      const message = m.message as { mid?: string } | undefined;
      const postback = m.postback as { mid?: string } | undefined;
      const sender = m.sender as { id?: string } | undefined;
      const ts = str(m.timestamp) ?? '';
      const id = message?.mid ?? postback?.mid ?? `postback:${sender?.id ?? 'unknown'}:${ts}`;
      out.push({
        kind: platform === 'INSTAGRAM' ? META_KINDS.igMessageEvent : META_KINDS.fbMessageEvent,
        externalId: id,
        raw: { ...m, entryId: entry.id },
        receivedAt,
        connectionHint: hint,
      });
    }
    for (const change of entry.changes ?? []) {
      const v = change.value;
      switch (change.field) {
        case 'feed': {
          const commentId = str(v.comment_id);
          if (str(v.item) !== 'comment' || !commentId) break; // likes, posts, reactions: reconciled by polling
          out.push({
            kind: META_KINDS.fbFeedChange,
            externalId: commentId,
            parentExternalId: str(v.post_id),
            raw: { ...v, entryId: entry.id },
            receivedAt,
            connectionHint: hint,
          });
          break;
        }
        case 'comments': {
          const id = str(v.id);
          if (!id) break;
          const media = v.media as { id?: string } | undefined;
          const parent = v.parent_id ?? (v.parent as { id?: string } | undefined)?.id;
          const from = v.from as { id?: string; username?: string } | undefined;
          out.push({
            kind: META_KINDS.igComment,
            externalId: id,
            parentExternalId: media?.id,
            raw: {
              id,
              text: str(v.text) ?? '',
              timestamp: receivedAt.toISOString(),
              username: from?.username,
              from: from?.id ? { id: from.id, username: from.username } : undefined,
              mediaId: media?.id,
              parentId: str(parent),
            },
            receivedAt,
            connectionHint: hint,
          });
          break;
        }
        case 'mentions': {
          const mediaId = str(v.media_id);
          const commentId = str(v.comment_id);
          if (!mediaId) break;
          out.push({
            kind: META_KINDS.igMention,
            externalId: commentId ?? mediaId,
            raw: { id: mediaId, comment_id: commentId, timestamp: receivedAt.toISOString() },
            receivedAt,
            connectionHint: hint,
          });
          break;
        }
        case 'leadgen': {
          const leadgenId = str(v.leadgen_id);
          if (!leadgenId) break;
          out.push({
            kind: META_KINDS.fbLeadgenEvent,
            externalId: leadgenId,
            parentExternalId: str(v.form_id),
            raw: v,
            receivedAt,
            connectionHint: hint,
          });
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}
