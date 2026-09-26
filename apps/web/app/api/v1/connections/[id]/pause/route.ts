/**
 * `POST /v1/connections/{id}/pause` (§11.2) — `setConnectionStatus` + `updateConnectionSettings`,
 * the pair the `connection.pause` procedure calls, so a REST pause and a UI pause leave the
 * connection in exactly the same state.
 */
import { pauseRequestSchema } from '@nexus/api';
import { NexusError } from '@nexus/core';
import { setConnectionStatus, updateConnectionSettings } from '@nexus/db';
import { restRoute } from '../../../_lib/handler';

export const dynamic = 'force-dynamic';

export const POST = restRoute<{ id: string }>('WRITE', async (ctx, params) => {
  const input = ctx.parse(pauseRequestSchema);
  return ctx.withTenant(async (db) => {
    const c = await db.connection.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true },
    });
    if (!c) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
    await setConnectionStatus(db, c.id, 'PAUSED', {
      pausedReason: input.reason ?? 'Paused through the public API.',
    });
    await updateConnectionSettings(db, c.id, { paused: true });
    await ctx.audit(db, {
      action: 'connection.paused',
      targetType: 'Connection',
      targetId: c.id,
      diff: { reason: input.reason ?? null, via: 'rest_v1' },
    });
    return { body: { id: c.id, status: 'PAUSED' } };
  });
});
