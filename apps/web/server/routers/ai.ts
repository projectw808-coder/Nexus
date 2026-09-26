/**
 * The AI surfaces (§13): conversation summaries, relationship briefs, AI research attributes,
 * reply drafting, transparent lead scoring, hybrid semantic search, and the per-workspace kill
 * switch/budget/PII-redaction settings. A human triggering one of these calls `@nexus/ai`
 * directly from the request — no queue round trip; a workflow's `enqueue_ai` action goes through
 * the `aiEnrich` queue in apps/worker instead (ADR-021).
 */
import { NexusError, parseAttributeConfig } from '@nexus/core';
import {
  aiSettingsFrom,
  checkAiAllowed,
  draftReply,
  generateRelationshipBrief,
  loadAiSettings,
  runResearchAttribute,
  scoreLead,
  semanticSearch,
  summarizeConversation,
  type AiDeps,
  type AiModel,
  type LeadSignals,
} from '@nexus/ai';
import { loadEnv } from '@nexus/config';
import { z } from 'zod';
import { authorize, router, tenantProcedure } from '../trpc';

const env = loadEnv();

async function depsFor(
  db: Parameters<typeof loadAiSettings>[0],
  workspaceId: string,
  model: AiModel,
): Promise<AiDeps> {
  const settings = await loadAiSettings(db, workspaceId, env.AI_PII_REDACTION);
  return { db, model, now: () => new Date(), settings };
}

async function computeLeadSignals(
  db: Parameters<typeof loadAiSettings>[0],
  recordId: string,
): Promise<LeadSignals> {
  const since30d = new Date(Date.now() - 30 * 24 * 3600_000);
  const [latest, recent, entry, record] = await Promise.all([
    db.timelineEvent.findFirst({
      where: { recordId, deletedAt: null },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    db.timelineEvent.findMany({
      where: { recordId, deletedAt: null, occurredAt: { gte: since30d } },
      select: { platform: true },
    }),
    db.listEntry.findFirst({
      where: { recordId, deletedAt: null, list: { kind: 'PIPELINE' } },
      select: { stage: true },
    }),
    db.record.findFirst({ where: { id: recordId, deletedAt: null }, select: { values: true } }),
  ]);
  const values = (record?.values ?? {}) as Record<string, unknown>;
  const hasVerifiedEmail = Object.values(values).some(
    (v) => typeof v === 'string' && /.+@.+\..+/.test(v),
  );
  return {
    lastTouchDaysAgo: latest
      ? Math.floor((Date.now() - latest.occurredAt.getTime()) / 86_400_000)
      : null,
    touchCountLast30d: recent.length,
    distinctPlatforms: new Set(recent.map((r) => r.platform).filter(Boolean)).size,
    pipelineStage: entry?.stage ?? null,
    hasVerifiedEmail,
  };
}

export const aiRouter = router({
  insights: router({
    list: tenantProcedure
      .use(authorize('read', 'AiInsight'))
      .input(
        z
          .object({
            recordId: z.string().uuid().optional(),
            conversationId: z.string().uuid().optional(),
          })
          .refine((v) => Boolean(v.recordId) !== Boolean(v.conversationId), {
            message: 'Pass exactly one of recordId or conversationId.',
          }),
      )
      .query(({ ctx, input }) =>
        ctx.db.aiInsight.findMany({
          where: {
            deletedAt: null,
            ...(input.recordId
              ? { recordId: input.recordId }
              : { conversationId: input.conversationId }),
          },
          orderBy: { generatedAt: 'desc' },
          take: 20,
        }),
      ),

    accept: tenantProcedure
      .use(authorize('update', 'AiInsight'))
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const existing = await ctx.db.aiInsight.findFirst({
          where: { id: input.id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) throw new NexusError('NOT_FOUND', { message: 'Insight not found.' });
        const row = await ctx.db.aiInsight.update({
          where: { id: input.id },
          data: { acceptedById: ctx.session.id, acceptedAt: new Date() },
        });
        await ctx.audit({
          action: 'ai_insight.accepted',
          targetType: 'AiInsight',
          targetId: row.id,
        });
        return row;
      }),

    dismiss: tenantProcedure
      .use(authorize('update', 'AiInsight'))
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const existing = await ctx.db.aiInsight.findFirst({
          where: { id: input.id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) throw new NexusError('NOT_FOUND', { message: 'Insight not found.' });
        const row = await ctx.db.aiInsight.update({
          where: { id: input.id },
          data: { dismissedAt: new Date() },
        });
        await ctx.audit({
          action: 'ai_insight.dismissed',
          targetType: 'AiInsight',
          targetId: row.id,
        });
        return row;
      }),
  }),

  summarizeConversation: tenantProcedure
    .use(authorize('create', 'AiInsight'))
    .input(z.object({ conversationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const result = await summarizeConversation(deps, {
        workspaceId: ctx.workspace.id,
        conversationId: input.conversationId,
      });
      await ctx.audit({
        action: 'ai_insight.generated',
        targetType: 'AiInsight',
        targetId: result.insightId,
        diff: { kind: 'conversation_summary', conversationId: input.conversationId },
      });
      return result;
    }),

  generateRelationshipBrief: tenantProcedure
    .use(authorize('create', 'AiInsight'))
    .input(z.object({ recordId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const result = await generateRelationshipBrief(deps, {
        workspaceId: ctx.workspace.id,
        recordId: input.recordId,
      });
      await ctx.audit({
        action: 'ai_insight.generated',
        targetType: 'AiInsight',
        targetId: result.insightId,
        diff: { kind: 'relationship_brief', recordId: input.recordId },
      });
      return result;
    }),

  runResearchAttribute: tenantProcedure
    .use(authorize('create', 'AiInsight'))
    .input(z.object({ recordId: z.string().uuid(), attributeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const attr = await ctx.db.attribute.findFirst({
        where: { id: input.attributeId, deletedAt: null, type: 'AI_RESEARCH' },
        select: { config: true },
      });
      if (!attr) throw new NexusError('NOT_FOUND', { message: 'AI research attribute not found.' });
      const config = parseAttributeConfig('AI_RESEARCH', attr.config);
      if (!config.ok) throw config.error;
      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const result = await runResearchAttribute(deps, {
        workspaceId: ctx.workspace.id,
        recordId: input.recordId,
        attributeId: input.attributeId,
        attributeConfig: config.value as never,
      });
      await ctx.audit({
        action: 'ai_insight.generated',
        targetType: 'AiInsight',
        targetId: result.insightId,
        diff: { kind: 'research', recordId: input.recordId, attributeId: input.attributeId },
      });
      return result;
    }),

  draftReply: tenantProcedure
    .use(authorize('update', 'Conversation'))
    .input(
      z.object({ conversationId: z.string().uuid(), instructions: z.string().max(500).optional() }),
    )
    .mutation(async ({ ctx, input }) => {
      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const draft = await draftReply(deps, {
        workspaceId: ctx.workspace.id,
        conversationId: input.conversationId,
        instructions: input.instructions,
      });
      await ctx.audit({
        action: 'ai.reply_drafted',
        targetType: 'Conversation',
        targetId: input.conversationId,
        diff: { promptVersion: draft.promptVersion },
      });
      return draft;
    }),

  scoreLead: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(z.object({ recordId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const record = await ctx.db.record.findFirst({
        where: { id: input.recordId, deletedAt: null },
        select: { id: true },
      });
      if (!record) throw new NexusError('NOT_FOUND', { message: 'Record not found.' });
      const settings = aiSettingsFrom(
        (
          await ctx.db.workspace.findFirst({
            where: { id: ctx.workspace.id },
            select: { settings: true },
          })
        )?.settings ?? {},
        env.AI_PII_REDACTION,
      );
      const signals = await computeLeadSignals(ctx.db, input.recordId);
      return scoreLead({ signals, weights: settings.leadScoreWeights });
    }),

  semanticSearch: tenantProcedure
    .use(authorize('read', 'Record'))
    .input(
      z.object({
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const allowed = await checkAiAllowed(ctx.db, ctx.workspace.id, 'embedding', deps.settings);
      if (!allowed.allowed) return { results: [], reason: allowed.reason };
      const results = await semanticSearch(deps, {
        workspaceId: ctx.workspace.id,
        query: input.query,
        limit: input.limit,
      });
      return { results, reason: undefined };
    }),

  settings: router({
    get: tenantProcedure.use(authorize('read', 'Workspace')).query(async ({ ctx }) => {
      const ws = await ctx.db.workspace.findFirstOrThrow({
        where: { id: ctx.workspace.id },
        select: { settings: true },
      });
      return aiSettingsFrom(ws.settings, env.AI_PII_REDACTION);
    }),

    update: tenantProcedure
      .use(authorize('update', 'Workspace'))
      .input(
        z.object({
          killSwitch: z.boolean().optional(),
          monthlyTokenBudget: z.number().int().positive().nullable().optional(),
          piiRedaction: z.enum(['strict', 'standard', 'off']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const ws = await ctx.db.workspace.findFirstOrThrow({
          where: { id: ctx.workspace.id },
          select: { settings: true },
        });
        const settings = (ws.settings ?? {}) as Record<string, unknown>;
        const ai = (settings['ai'] ?? {}) as Record<string, unknown>;
        const nextAi = {
          ...ai,
          ...(input.killSwitch !== undefined ? { killSwitch: input.killSwitch } : {}),
          ...(input.monthlyTokenBudget !== undefined
            ? { monthlyTokenBudget: input.monthlyTokenBudget ?? undefined }
            : {}),
          ...(input.piiRedaction !== undefined ? { piiRedaction: input.piiRedaction } : {}),
        };
        await ctx.db.workspace.update({
          where: { id: ctx.workspace.id },
          data: { settings: { ...settings, ai: nextAi } },
        });
        await ctx.audit({
          action: 'workspace.ai_settings_updated',
          targetType: 'Workspace',
          targetId: ctx.workspace.id,
          diff: input,
        });
        return aiSettingsFrom({ ...settings, ai: nextAi }, env.AI_PII_REDACTION);
      }),
  }),
});
