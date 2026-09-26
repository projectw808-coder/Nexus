/**
 * §13.3 the AI research attribute: an agent answers a per-record question and returns a *typed,
 * filterable* value with sources and a staleness date.
 *
 * `AI_RESEARCH` is in `COMPUTED_TYPES`, so `updateRecord`/`validateRecordValues` in `@nexus/db`
 * reject writes to it outright — there is deliberately no privileged bypass there. This package
 * owns the semantics of the one attribute type it produces, so the narrow writer lives here:
 * validate against `aiResearchValueSchema`, merge into the record's JSONB, then emit the same
 * `FIELD_CHANGE` timeline event and audit row any other field change would leave behind.
 */
import { NexusError, aiResearchValueSchema } from '@nexus/core';
import { emitTimelineEvent, systemActorFor, writeAudit } from '@nexus/db';
import type { Actor, Prisma, TenantDb } from '@nexus/db';
import { assertAllowed, checkAiAllowed, recordAiUsage } from './budget.ts';
import {
  filterCitations,
  personContext,
  renderRecordValues,
  type AiDeps,
  type AiInsightResult,
} from './context.ts';
import { PROMPT_VERSIONS, researchAttributePrompt, researchSchemaFor } from './prompts.ts';
import { generateStructured } from './structured.ts';

const asJson = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export type AiResearchConfig = {
  prompt: string;
  outputType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  options?: { id: string; label: string }[];
  refreshDays?: number;
};

export type AiResearchValue = {
  value: string | number | boolean | null;
  sources: { url: string; title?: string }[];
  asOf: string;
  confidence?: number;
};

/**
 * The privileged `AI_RESEARCH` write. Read-modify-write on `Record.values` (there is no partial
 * JSONB update helper), then timeline + audit so it looks like any other field change.
 */
export async function writeAiResearchValue(
  db: TenantDb,
  input: {
    workspaceId: string;
    recordId: string;
    attributeId: string;
    value: unknown;
    now?: Date;
  },
  actor?: Actor,
): Promise<{ before: unknown; after: AiResearchValue }> {
  const parsed = aiResearchValueSchema.safeParse(input.value);
  if (!parsed.success) {
    throw new NexusError('VALIDATION', {
      message: 'invalid AI_RESEARCH value',
      context: { reason: 'The research agent produced a value this attribute cannot store.' },
      details: {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  const value: AiResearchValue = parsed.data;

  const attribute = await db.attribute.findFirst({
    where: { id: input.attributeId, deletedAt: null },
    select: { id: true, type: true, apiSlug: true, title: true },
  });
  if (!attribute) throw new NexusError('NOT_FOUND', { message: 'attribute not found' });
  if (attribute.type !== 'AI_RESEARCH') {
    throw new NexusError('VALIDATION', {
      message: `attribute ${attribute.apiSlug} is ${attribute.type}, not AI_RESEARCH`,
      context: { reason: 'This writer only writes AI_RESEARCH attributes.' },
    });
  }

  const record = await db.record.findFirst({
    where: { id: input.recordId, deletedAt: null, mergeState: 'ACTIVE' },
    select: { id: true, values: true },
  });
  if (!record) throw new NexusError('NOT_FOUND', { message: 'record not found' });

  const current = (record.values ?? {}) as Record<string, unknown>;
  const before = current[input.attributeId] ?? null;
  const merged: Record<string, unknown> = { ...current, [input.attributeId]: value };

  await db.record.update({
    where: { id: record.id },
    data: { values: merged as Prisma.InputJsonValue },
  });

  const writer = actor ?? systemActorFor(input.workspaceId);
  const at = input.now ?? new Date();

  await emitTimelineEvent(db, {
    workspaceId: input.workspaceId,
    dedupeKey: `ai-research:${record.id}:${attribute.id}:${value.asOf}`,
    type: 'FIELD_CHANGE',
    occurredAt: at,
    summary: `${attribute.title} researched by AI`,
    recordId: record.id,
    payload: {
      attributeId: attribute.id,
      attributeSlug: attribute.apiSlug,
      source: 'ai_research',
      from: before,
      to: value,
    },
  });

  await writeAudit(db, writer, {
    action: 'record.ai_research_updated',
    targetType: 'Record',
    targetId: record.id,
    diff: { [attribute.apiSlug]: { from: before, to: value } },
  });

  return { before, after: value };
}

// ── the feature function ─────────────────────────────────────────────────────

export async function runResearchAttribute(
  deps: AiDeps,
  input: {
    workspaceId: string;
    recordId: string;
    attributeId: string;
    attributeConfig: AiResearchConfig;
  },
): Promise<AiInsightResult> {
  assertAllowed(
    await checkAiAllowed(deps.db, input.workspaceId, 'research', deps.settings, {
      now: deps.now(),
    }),
    'research',
  );

  const record = await deps.db.record.findFirst({
    where: { id: input.recordId, deletedAt: null, mergeState: 'ACTIVE' },
    select: { id: true, objectTypeId: true, values: true },
  });
  if (!record) throw new NexusError('NOT_FOUND', { message: 'record not found' });

  const attributes = await deps.db.attribute.findMany({
    where: { objectTypeId: record.objectTypeId, deletedAt: null },
    orderBy: { position: 'asc' },
    select: { id: true, title: true },
    take: 50,
  });

  const events = await personContext(deps.db, deps.settings, input.recordId, 15);
  const prompt = researchAttributePrompt({
    question: input.attributeConfig.prompt,
    outputType: input.attributeConfig.outputType,
    ...(input.attributeConfig.options ? { options: input.attributeConfig.options } : {}),
    recordSummary: renderRecordValues(record.values, attributes, deps.settings.piiRedaction),
    events,
  });

  const out = await generateStructured(deps.model, {
    promptVersion: PROMPT_VERSIONS.research_attribute,
    system: prompt.system,
    user: prompt.user,
    schema: researchSchemaFor(input.attributeConfig.outputType, input.attributeConfig.options),
  });

  const asOf = deps.now().toISOString();
  const confidence = out.data.confidence ?? 0.5;
  const value: AiResearchValue = {
    value: out.data.value,
    sources: out.data.sources,
    asOf,
    confidence,
  };

  await writeAiResearchValue(deps.db, {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    attributeId: input.attributeId,
    value,
    now: deps.now(),
  });

  // Citations stay TimelineEvent ids (the shared discipline); web-ish sources live in
  // `content.sources`. An empty array is correct when there was no timeline evidence.
  const citations = filterCitations(out.data.citations, events);
  const content = {
    kind: 'research_attribute' as const,
    attributeId: input.attributeId,
    question: input.attributeConfig.prompt,
    outputType: input.attributeConfig.outputType,
    value: out.data.value,
    sources: out.data.sources,
    asOf,
  };

  const insight = await deps.db.aiInsight.create({
    data: {
      workspaceId: input.workspaceId,
      recordId: input.recordId,
      kind: 'RESEARCH',
      content: asJson(content),
      model: out.model,
      promptVersion: out.promptVersion,
      confidence,
      citations: asJson(citations),
      generatedAt: deps.now(),
    },
    select: { id: true },
  });

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'research',
    model: out.model,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  });

  return {
    insightId: insight.id,
    content,
    citations,
    confidence,
    model: out.model,
    promptVersion: out.promptVersion,
  };
}
