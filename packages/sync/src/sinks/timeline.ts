/**
 * Stage 5 for the timeline (§6.3, ADR-003): every canonical entity that is an act by a person
 * becomes ONE `TimelineEvent` attached to that person's `Identity` — and to the resolved Person
 * at once when the identity is already linked. Events are idempotent on a dedupe key built from
 * the connection and the platform id, so replays and webhook redeliveries never double up.
 *
 * Lead-form submissions carry no platform user id; they get a synthetic identity keyed
 * `lead:<leadId>` on the same platform so the e-mail/phone on the form can resolve them (§10).
 */
import type { CanonicalEntity, CanonicalMessage } from '@nexus/connector-sdk';
import {
  emitTimelineEvent,
  systemActorFor,
  upsertIdentity,
  type TenantRuntime,
  type TimelineType,
} from '@nexus/db';
import type { CanonicalSink, NormalizedBatch } from '../sink.ts';

export type TimelineSinkStats = { events: number; skipped: number };

const excerpt = (s: string, n = 140): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const MESSAGE_TYPE: Record<CanonicalMessage['messageType'], TimelineType> = {
  dm: 'MESSAGE',
  comment: 'COMMENT',
  reply: 'COMMENT',
  mention: 'MENTION',
  email: 'EMAIL',
  review_reply: 'COMMENT',
  other: 'MESSAGE',
};

function inboundVerb(m: CanonicalMessage): string {
  switch (m.messageType) {
    case 'dm':
      return 'Sent a message';
    case 'comment':
      return 'Commented';
    case 'reply':
      return 'Replied to a comment';
    case 'mention':
      return 'Mentioned you';
    case 'email':
      return 'Sent an e-mail';
    case 'review_reply':
      return 'Replied to a review';
    default:
      return 'Wrote';
  }
}

export function createTimelineSink(
  runtime: TenantRuntime,
): CanonicalSink & { stats: TimelineSinkStats } {
  const stats: TimelineSinkStats = { events: 0, skipped: 0 };

  return {
    stats,
    async materialize(batch: NormalizedBatch) {
      const work: { objectId: string; entity: CanonicalEntity }[] = [];
      for (const item of batch.items)
        for (const e of item.entities)
          if (
            e.kind === 'message' ||
            e.kind === 'engagement' ||
            e.kind === 'review' ||
            e.kind === 'lead'
          )
            work.push({ objectId: item.objectId, entity: e });
      if (!work.length) return;

      const actor = systemActorFor(batch.workspaceId, batch.connectionId);
      await runtime.withTenant(actor, async (db) => {
        const identityCache = new Map<string, string>();
        const identityIdFor = async (externalId: string, seenAt: Date): Promise<string> => {
          const cached = identityCache.get(externalId);
          if (cached) return cached;
          const r = await upsertIdentity(db, {
            workspaceId: batch.workspaceId,
            platform: batch.platform,
            externalId,
            seenAt,
            connectionId: batch.connectionId,
          });
          identityCache.set(externalId, r.id);
          return r.id;
        };
        const conversationIdentity = async (externalId: string): Promise<string | null> => {
          const c = await db.conversation.findFirst({
            where: { connectionId: batch.connectionId, externalId },
            select: { identityId: true },
          });
          return c?.identityId ?? null;
        };
        const common = (objectId: string) => ({
          workspaceId: batch.workspaceId,
          platform: batch.platform,
          connectionId: batch.connectionId,
          externalObjectId: objectId,
        });

        for (const { objectId, entity: e } of work) {
          let created = false;
          if (e.kind === 'message') {
            const key = `msg:${batch.connectionId}:${e.conversationExternalId}:${e.externalId}`;
            if (e.direction === 'inbound') {
              const identityId = await identityIdFor(e.authorExternalId, e.sentAt);
              const r = await emitTimelineEvent(db, {
                ...common(objectId),
                dedupeKey: key,
                type: MESSAGE_TYPE[e.messageType],
                occurredAt: e.sentAt,
                identityId,
                actorIdentityId: identityId,
                summary: `${inboundVerb(e)}: “${excerpt(e.body) || '(attachment)'}”`,
                payload: {
                  kind: 'message',
                  direction: 'inbound',
                  messageType: e.messageType,
                  conversationExternalId: e.conversationExternalId,
                  body: excerpt(e.body, 500),
                  attachments: e.attachments.length,
                  ...(e.rootExternalId ? { rootExternalId: e.rootExternalId } : {}),
                },
                sourceUrl: e.sourceUrl,
              });
              created = r.created;
            } else {
              const identityId =
                (await conversationIdentity(e.conversationExternalId)) ??
                (e.recipientExternalIds?.[0]
                  ? await identityIdFor(e.recipientExternalIds[0], e.sentAt)
                  : null);
              if (!identityId) {
                stats.skipped += 1;
                continue;
              }
              let actorUserId: string | null = null;
              if (e.outboundActionId) {
                const oa = await db.outboundAction.findFirst({
                  where: { id: e.outboundActionId },
                  select: { requestedByUserId: true },
                });
                actorUserId = oa?.requestedByUserId ?? null;
              }
              const r = await emitTimelineEvent(db, {
                ...common(objectId),
                dedupeKey: key,
                type: MESSAGE_TYPE[e.messageType],
                occurredAt: e.sentAt,
                identityId,
                actorUserId,
                summary: `${actorUserId ? 'You replied' : 'The account replied'}: “${excerpt(e.body) || '(attachment)'}”`,
                payload: {
                  kind: 'message',
                  direction: 'outbound',
                  messageType: e.messageType,
                  conversationExternalId: e.conversationExternalId,
                  body: excerpt(e.body, 500),
                  attachments: e.attachments.length,
                  ...(e.outboundActionId ? { outboundActionId: e.outboundActionId } : {}),
                },
                sourceUrl: e.sourceUrl,
              });
              created = r.created;
            }
          } else if (e.kind === 'engagement') {
            if (!e.actorExternalId) {
              stats.skipped += 1;
              continue;
            }
            const identityId = await identityIdFor(e.actorExternalId, e.occurredAt);
            const verb =
              e.engagementType === 'reaction'
                ? `Reacted${e.reactionType ? ` (${e.reactionType})` : ''} to`
                : e.engagementType === 'like'
                  ? 'Liked'
                  : e.engagementType === 'share'
                    ? 'Shared'
                    : e.engagementType === 'save'
                      ? 'Saved'
                      : e.engagementType === 'follow'
                        ? 'Followed'
                        : e.engagementType === 'unfollow'
                          ? 'Unfollowed'
                          : 'Viewed';
            const r = await emitTimelineEvent(db, {
              ...common(objectId),
              dedupeKey: `eng:${batch.connectionId}:${e.externalId}`,
              type: 'POST_ENGAGEMENT',
              occurredAt: e.occurredAt,
              identityId,
              actorIdentityId: identityId,
              summary: `${verb} ${e.targetKind === 'account' ? 'the account' : `a ${e.targetKind}`}`,
              payload: {
                kind: 'engagement',
                engagementType: e.engagementType,
                targetKind: e.targetKind,
                targetExternalId: e.targetExternalId,
                ...(e.reactionType ? { reactionType: e.reactionType } : {}),
              },
              sourceUrl: e.sourceUrl,
            });
            created = r.created;
          } else if (e.kind === 'review') {
            if (!e.authorExternalId) {
              stats.skipped += 1;
              continue;
            }
            const identityId = await identityIdFor(e.authorExternalId, e.reviewedAt);
            const rating =
              e.rating !== null
                ? `${e.rating}/${e.maxRating}`
                : e.recommends === undefined
                  ? null
                  : e.recommends
                    ? 'recommends'
                    : 'does not recommend';
            const r = await emitTimelineEvent(db, {
              ...common(objectId),
              dedupeKey: `review:${batch.connectionId}:${e.externalId}`,
              type: 'COMMENT',
              occurredAt: e.reviewedAt,
              identityId,
              actorIdentityId: identityId,
              summary: `Left a review${rating ? ` (${rating})` : ''}${e.body ? `: “${excerpt(e.body)}”` : ''}`,
              payload: {
                kind: 'review',
                rating: e.rating,
                maxRating: e.maxRating,
                ...(e.recommends !== undefined ? { recommends: e.recommends } : {}),
                body: excerpt(e.body, 500),
                ...(e.reply ? { replied: true } : {}),
              },
              sourceUrl: e.sourceUrl,
            });
            created = r.created;
          } else if (e.kind === 'lead') {
            const lead = await upsertIdentity(db, {
              workspaceId: batch.workspaceId,
              platform: batch.platform,
              externalId: `lead:${e.externalId}`,
              seenAt: e.submittedAt,
              displayName: e.fullName ?? null,
              email: e.email ?? null,
              phone: e.phone ?? null,
              raw: { lead: e.raw },
              canonical: e.companyName ? { bio: e.companyName } : undefined,
              connectionId: batch.connectionId,
            });
            identityCache.set(`lead:${e.externalId}`, lead.id);
            const r = await emitTimelineEvent(db, {
              ...common(objectId),
              dedupeKey: `lead:${batch.connectionId}:${e.externalId}`,
              type: 'LEAD_FORM',
              occurredAt: e.submittedAt,
              identityId: lead.id,
              actorIdentityId: lead.id,
              summary: `Submitted ${e.formName ? `the “${e.formName}” form` : 'a lead form'}${e.fullName ? ` as ${e.fullName}` : ''}`,
              payload: {
                kind: 'lead',
                source: e.source,
                formExternalId: e.formExternalId ?? null,
                formName: e.formName ?? null,
                fields: e.fields.map((f) => ({
                  name: f.name,
                  label: f.label ?? null,
                  value: f.value,
                })),
                ...(e.campaignExternalId ? { campaignExternalId: e.campaignExternalId } : {}),
                ...(e.adExternalId ? { adExternalId: e.adExternalId } : {}),
              },
              sourceUrl: e.sourceUrl,
            });
            created = r.created;
          }
          if (created) stats.events += 1;
        }
      });
    },
  };
}
