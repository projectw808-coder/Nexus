/**
 * Workspace API keys (spec §11.2, ADR-022) — the *management* surface, reached the normal way:
 * a signed-in member of the workspace, through tRPC and CASL. The keys themselves authenticate
 * external REST v1 callers, which is a different transport entirely (`apps/web/app/api/v1/**`).
 *
 * `create` is the only procedure that ever returns a plaintext key, and it returns it exactly
 * once — nothing stores it, so nothing can show it again.
 */
import { NexusError } from '@nexus/core';
import { ApiKeyScope, createApiKey, listApiKeys, revokeApiKey } from '@nexus/db';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const scopeEnum = z.enum(Object.values(ApiKeyScope) as [ApiKeyScope, ...ApiKeyScope[]]);

export const apiKeyRouter = router({
  list: tenantProcedure.use(authorize('read', 'ApiKey')).query(async ({ ctx }) => {
    const rows = await listApiKeys(ctx.db, ctx.workspace.id);
    const creators = await ctx.db.user.findMany({
      where: { id: { in: rows.flatMap((r) => (r.createdById ? [r.createdById] : [])) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(creators.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      rateLimitPerMinute: r.rateLimitPerMinute,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      createdAt: r.createdAt,
      createdBy: r.createdById ? (byId.get(r.createdById) ?? null) : null,
    }));
  }),

  create: tenantProcedure
    .use(authorize('create', 'ApiKey'))
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(scopeEnum).min(1).max(3).default(['READ']),
        rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
        throw new NexusError('VALIDATION', {
          context: { reason: 'An expiry date has to be in the future.' },
        });
      }
      const created = await createApiKey(ctx.db, ctx.actor, {
        name: input.name,
        scopes: input.scopes,
        rateLimitPerMinute: input.rateLimitPerMinute ?? null,
        expiresAt: input.expiresAt ?? null,
      });
      await ctx.audit({
        action: 'api_key.created',
        targetType: 'ApiKey',
        targetId: created.id,
        // The prefix, never the key: an audit row is not a place to leak a credential.
        diff: { name: input.name, prefix: created.prefix, scopes: input.scopes },
      });
      return created;
    }),

  revoke: tenantProcedure
    .use(authorize('delete', 'ApiKey'))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.apiKey.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, name: true, prefix: true, revokedAt: true },
      });
      if (!row) throw new NexusError('NOT_FOUND', { message: 'API key not found.' });
      if (row.revokedAt) {
        throw new NexusError('CONFLICT', {
          context: { reason: 'That key was already revoked.' },
        });
      }
      await revokeApiKey(ctx.db, row.id);
      await ctx.audit({
        action: 'api_key.revoked',
        targetType: 'ApiKey',
        targetId: row.id,
        diff: { name: row.name, prefix: row.prefix },
      });
      return { id: row.id };
    }),
});
