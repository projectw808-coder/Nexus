/**
 * The admin AI assistant (owner/admin only, `AiAssistant` — §5.2): a chat surface that answers
 * integration questions and can create or edit a Client record as a side effect. The model never
 * writes directly — `runAssistant` returns a structured `action`, which this router re-executes
 * through the same createRecord/updateRecord path (and audit/timeline/webhook fan-out) a manual
 * edit would use, exactly like `records.ts`'s own create/update mutations.
 */
import {
  loadAiSettings,
  runAssistant,
  type AiDeps,
  type AiModel,
  type AssistantClientContext,
  type AssistantIntegrationContext,
} from '@nexus/ai';
import { createRecord, diffOf, emitTimelineEvent, updateRecord } from '@nexus/db';
import { loadEnv } from '@nexus/config';
import { dispatchOutboundWebhooks } from '@nexus/sync';
import { z } from 'zod';
import { attributesFor, recordLabel, resolveObjectType } from '../objects-helpers';
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

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const assistantRouter = router({
  chat: tenantProcedure
    .use(authorize('create', 'AiAssistant'))
    .input(
      z.object({
        message: z.string().trim().min(1).max(2000),
        history: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
          .max(20)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ot = await resolveObjectType(ctx.db, 'client');
      const attrs = await attributesFor(ctx.db, ot.id);
      const nameAttr = attrs.find((a) => a.apiSlug === 'name');
      const emailAttr = attrs.find((a) => a.apiSlug === 'email');
      const statusAttr = attrs.find((a) => a.apiSlug === 'status');
      const valueAt = (values: unknown, attr?: { id: string }): unknown =>
        attr && isDict(values) ? (values[attr.id] ?? null) : null;

      const [clientRows, connectionRows] = await Promise.all([
        ctx.db.record.findMany({
          where: { objectTypeId: ot.id, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 30,
          select: { id: true, values: true },
        }),
        ctx.db.connection.findMany({
          where: { deletedAt: null },
          select: { platform: true, status: true },
        }),
      ]);

      const clients: AssistantClientContext[] = clientRows.map((r) => ({
        id: r.id,
        name: (valueAt(r.values, nameAttr) as string | null) ?? '(unnamed)',
        email: (valueAt(r.values, emailAttr) as string | null) ?? null,
        status: (valueAt(r.values, statusAttr) as string | null) ?? null,
      }));

      const integrations: AssistantIntegrationContext[] = connectionRows.map((c) => ({
        platform: c.platform,
        connected: c.status === 'CONNECTED',
      }));

      const deps = await depsFor(ctx.db, ctx.workspace.id, ctx.aiModel);
      const result = await runAssistant(deps, {
        workspaceId: ctx.workspace.id,
        message: input.message,
        history: input.history,
        clients,
        integrations,
      });

      let created: { id: string; label: string } | null = null;
      let updated: { id: string; label: string } | null = null;

      if (result.action.tool === 'create_client') {
        const { tool: _tool, ...values } = result.action;
        const row = await createRecord(ctx.db, ctx.actor, {
          objectTypeId: ot.id,
          attributes: attrs,
          input: values,
        });
        await ctx.jobs.dispatch('automate.react', {
          workspaceId: ctx.workspace.id,
          type: 'record.created',
          occurredAt: new Date().toISOString(),
          recordId: row.id,
          objectTypeApiSlug: ot.apiSlug,
          payload: { values: row.values },
          causation: { workflowIds: [] },
        });
        await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
          workspaceId: ctx.workspace.id,
          type: 'record.created',
          recordId: row.id,
          objectTypeApiSlug: ot.apiSlug,
          payload: { values: row.values },
        });
        created = { id: row.id, label: recordLabel(attrs, row.values) };
      } else if (result.action.tool === 'update_client') {
        const { tool: _tool, clientId, ...values } = result.action;
        const { before, after } = await updateRecord(ctx.db, ctx.actor, {
          recordId: clientId,
          attributes: attrs,
          input: values,
        });
        const changed = diffOf(before.values, after.values);
        const changedTitles = Object.keys(changed)
          .map((k) => attrs.find((a) => a.id === k)?.title ?? null)
          .filter((t): t is string => t !== null);
        if (changedTitles.length) {
          await emitTimelineEvent(ctx.db, {
            workspaceId: ctx.workspace.id,
            dedupeKey: `field:${after.id}:${Date.now()}`,
            type: 'FIELD_CHANGE',
            occurredAt: new Date(),
            recordId: after.id,
            actorUserId: ctx.session.id,
            summary: `AI assistant changed ${changedTitles.slice(0, 3).join(', ')}${changedTitles.length > 3 ? ` and ${changedTitles.length - 3} more` : ''}`,
            payload: { kind: 'field_change', changed },
          });
          await ctx.jobs.dispatch('automate.react', {
            workspaceId: ctx.workspace.id,
            type: 'record.updated',
            occurredAt: new Date().toISOString(),
            recordId: after.id,
            objectTypeApiSlug: ot.apiSlug,
            payload: { changed, values: after.values },
            causation: { workflowIds: [] },
          });
          await dispatchOutboundWebhooks(ctx.db, ctx.sync.bus, {
            workspaceId: ctx.workspace.id,
            type: 'record.updated',
            recordId: after.id,
            objectTypeApiSlug: ot.apiSlug,
            payload: { changed, values: after.values },
          });
        }
        updated = { id: after.id, label: recordLabel(attrs, after.values) };
      }

      await ctx.audit({
        action: 'ai_assistant.chat',
        targetType: 'AiAssistant',
        targetId: created?.id ?? updated?.id ?? ctx.session.id,
        diff: {
          promptVersion: result.promptVersion,
          tool: result.action.tool,
          ...(created ? { created: created.id } : {}),
          ...(updated ? { updated: updated.id } : {}),
        },
      });

      return { reply: result.reply, tool: result.action.tool, created, updated };
    }),
});
