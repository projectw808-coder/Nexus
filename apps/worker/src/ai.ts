/**
 * Hosts the `aiEnrich` queue (spec §13): background AI jobs a workflow's `enqueue_ai` action
 * fires (ADR-021 — `@nexus/automation` never imports `@nexus/ai`; this is the one place that
 * wires them together). A human clicking "regenerate" in the UI calls the same `@nexus/ai`
 * functions directly from a tRPC mutation instead — no queue round-trip needed there.
 */
import { QUEUE_PREFIX, QUEUES, loadEnv } from '@nexus/config';
import {
  aiModelFromEnv,
  checkAiAllowed,
  embedAndStore,
  generateRelationshipBrief,
  loadAiSettings,
  runResearchAttribute,
  summarizeConversation,
  type AiDeps,
  type AiModel,
} from '@nexus/ai';
import { parseAttributeConfig } from '@nexus/core';
import { runtime, systemActorFor } from '@nexus/db';
import type { Logger } from '@nexus/telemetry';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { z } from 'zod';

const aiJobSchema = z.object({
  workspaceId: z.string().min(1),
  feature: z.enum(['summary', 'relationship_brief', 'research', 'embedding']),
  payload: z.record(z.string(), z.unknown()),
});

export type AiHost = { worker: Worker; close(): Promise<void> };

/** Real work, split out so a test can call it directly with an injected `model`. */
export async function handleAiJob(
  data: z.infer<typeof aiJobSchema>,
  opts: { model: AiModel; piiRedactionDefault: 'strict' | 'standard' | 'off' },
): Promise<unknown> {
  const actor = systemActorFor(data.workspaceId);
  return runtime.withTenant(actor, async (db) => {
    const settings = await loadAiSettings(db, data.workspaceId, opts.piiRedactionDefault);
    const deps: AiDeps = { db, model: opts.model, now: () => new Date(), settings };
    switch (data.feature) {
      case 'summary':
        return summarizeConversation(deps, {
          workspaceId: data.workspaceId,
          conversationId: String(data.payload['conversationId']),
        });
      case 'relationship_brief':
        return generateRelationshipBrief(deps, {
          workspaceId: data.workspaceId,
          recordId: String(data.payload['recordId']),
        });
      case 'research': {
        const attributeId = String(data.payload['attributeId']);
        const attr = await db.attribute.findFirst({
          where: { id: attributeId, deletedAt: null },
          select: { config: true },
        });
        if (!attr) throw new Error(`attribute ${attributeId} not found`);
        const config = parseAttributeConfig('AI_RESEARCH', attr.config);
        if (!config.ok) throw config.error;
        return runResearchAttribute(deps, {
          workspaceId: data.workspaceId,
          recordId: String(data.payload['recordId']),
          attributeId,
          attributeConfig: config.value as unknown as {
            prompt: string;
            outputType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
            options?: { id: string; label: string }[];
          },
        });
      }
      case 'embedding': {
        const allowed = await checkAiAllowed(db, data.workspaceId, 'embedding', settings);
        if (!allowed.allowed) return { skipped: allowed.reason };
        return embedAndStore(deps, {
          workspaceId: data.workspaceId,
          sourceType: String(data.payload['sourceType']),
          sourceId: String(data.payload['sourceId']),
          text: String(data.payload['text']),
        });
      }
    }
  });
}

export function startAiHost(opts: { redis: IORedis; log: Logger }): AiHost {
  const env = loadEnv();
  const model = aiModelFromEnv({ AI_PROVIDER: env.AI_PROVIDER, AI_API_KEY: env.AI_API_KEY });
  const worker = new Worker(
    QUEUES.aiEnrich,
    async (job: Job) => {
      const data = aiJobSchema.parse(job.data);
      return handleAiJob(data, { model, piiRedactionDefault: env.AI_PII_REDACTION });
    },
    { connection: opts.redis, prefix: QUEUE_PREFIX, concurrency: 2 },
  );
  worker.on('failed', (job, error) => {
    opts.log.error({ jobId: job?.id, err: error }, 'ai job failed');
  });
  worker.on('error', (error) => opts.log.error({ err: error }, 'ai worker error'));
  return {
    worker,
    async close() {
      await worker.close();
    },
  };
}
