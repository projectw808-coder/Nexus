/**
 * `GET /v1/people/{id}/timeline` — the unified, cursor-paginated, platform-filterable stream
 * (§6.3, §11.2).
 *
 * `queryTimeline` is the only sanctioned reader: it unions events attached to the person with
 * events still attached to one of their channel identities, so an unresolved identity's history
 * is neither lost nor doubled. This endpoint adds nothing to that but the wire format.
 */
import { timelineQuerySchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { Platform, TimelineType, queryTimeline } from '@nexus/db';
import { restRoute } from '../../../_lib/handler';
import { cappedLimit } from '../../../_lib/shapes';

export const dynamic = 'force-dynamic';

function asPlatform(value: string | undefined): Platform | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return (Object.values(Platform) as string[]).includes(upper) ? (upper as Platform) : null;
}

function asType(value: string | undefined): TimelineType | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return (Object.values(TimelineType) as string[]).includes(upper) ? (upper as TimelineType) : null;
}

export const GET = restRoute<{ id: string }>('READ', async (ctx, params) => {
  const q = ctx.query(timelineQuerySchema);
  const platform = asPlatform(q.platform);
  if (q.platform && !platform) {
    throw new NexusError('VALIDATION', {
      context: { reason: `Unknown platform "${q.platform}".` },
    });
  }
  const type = asType(q.type);
  if (q.type && !type) {
    throw new NexusError('VALIDATION', { context: { reason: `Unknown event type "${q.type}".` } });
  }
  return ctx.withTenant(async (db, actor) => {
    const person = await db.record.findFirst({
      where: { id: params.id, objectType: { apiSlug: 'person' } },
      select: { id: true },
    });
    if (!person) throw new NexusError('NOT_FOUND', { message: 'Person not found.' });
    const page = await queryTimeline(db, {
      workspaceId: actor.workspaceId,
      recordId: person.id,
      ...(platform ? { platforms: [platform] } : {}),
      ...(type ? { types: [type] } : {}),
      cursor: q.cursor ?? null,
      limit: cappedLimit(q.limit),
    });
    return {
      body: {
        items: page.items.map((e) => ({
          id: e.id,
          type: e.type,
          platform: e.platform,
          occurredAt: e.occurredAt,
          summary: e.summary,
          sourceUrl: e.sourceUrl,
          recordId: e.recordId,
          provenance: e.provenance,
          connection: e.connection,
          payload: e.payload,
        })),
        nextCursor: page.nextCursor,
        facets: page.facets,
      },
    };
  });
});
