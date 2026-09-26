/**
 * `POST /v1/connections/{id}/resume` (§11.2). A connection whose token is gone cannot be
 * resumed by an API call — a human has to reconnect — so that case is an AUTH_EXPIRED problem,
 * the same refusal the UI gives.
 */
import { NexusError } from '@nexus/core';
import { setConnectionStatus, updateConnectionSettings } from '@nexus/db';
import { restRoute } from '../../../_lib/handler';

export const dynamic = 'force-dynamic';

export const POST = restRoute<{ id: string }>('WRITE', async (ctx, params) =>
  ctx.withTenant(async (db) => {
    const c = await db.connection.findFirst({
      where: { id: params.id, deletedAt: null },
      select: { id: true, status: true, label: true },
    });
    if (!c) throw new NexusError('NOT_FOUND', { message: 'Connection not found.' });
    if (c.status === 'RECONNECT_REQUIRED' || c.status === 'REVOKED') {
      throw new NexusError('AUTH_EXPIRED', { context: { connectionLabel: c.label } });
    }
    await setConnectionStatus(db, c.id, 'CONNECTED', { pausedReason: null });
    await updateConnectionSettings(db, c.id, { paused: false });
    await ctx.audit(db, {
      action: 'connection.resumed',
      targetType: 'Connection',
      targetId: c.id,
      diff: { via: 'rest_v1' },
    });
    return { body: { id: c.id, status: 'CONNECTED' } };
  }),
);
