/**
 * §13.1 conversation summary, §13.2 relationship brief and §13.4 reply drafting.
 *
 * Both stored outputs use `AiInsightKind.SUMMARY` and are told apart by `content.kind`
 * ('conversation_summary' vs 'relationship_brief') — ADR-021: the enum has no slot for "brief"
 * and `content` is deliberately schema-flexible JSON for exactly this. A draft reply is not
 * persisted as an insight; the spec does not ask for it and it is never auto-sent.
 */
import { NexusError } from '@nexus/core';
import type { Prisma } from '@nexus/db';
import { assertAllowed, checkAiAllowed, recordAiUsage, type AiFeature } from './budget.ts';
import {
  conversationContext,
  filterCitations,
  personContext,
  type AiDeps,
  type AiInsightResult,
} from './context.ts';
import {
  PROMPT_VERSIONS,
  conversationSummaryPrompt,
  conversationSummarySchema,
  relationshipBriefPrompt,
  relationshipBriefSchema,
  replyDraftPrompt,
  replyDraftSchema,
} from './prompts.ts';
import { generateStructured } from './structured.ts';

const asJson = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

async function gate(deps: AiDeps, workspaceId: string, feature: AiFeature): Promise<void> {
  assertAllowed(
    await checkAiAllowed(deps.db, workspaceId, feature, deps.settings, { now: deps.now() }),
    feature,
  );
}

// ── §13.1 ────────────────────────────────────────────────────────────────────

export async function summarizeConversation(
  deps: AiDeps,
  input: { workspaceId: string; conversationId: string },
): Promise<AiInsightResult> {
  await gate(deps, input.workspaceId, 'summary');

  const conversation = await deps.db.conversation.findFirst({
    where: { id: input.conversationId, deletedAt: null },
    select: {
      id: true,
      externalId: true,
      connectionId: true,
      identityId: true,
      personRecordId: true,
      platform: true,
      kind: true,
    },
  });
  if (!conversation) {
    throw new NexusError('NOT_FOUND', { message: 'conversation not found' });
  }

  const events = await conversationContext(deps.db, deps.settings, conversation);
  const prompt = conversationSummaryPrompt({
    platform: conversation.platform,
    kind: conversation.kind,
    events,
  });
  const out = await generateStructured(deps.model, {
    promptVersion: PROMPT_VERSIONS.conversation_summary,
    system: prompt.system,
    user: prompt.user,
    schema: conversationSummarySchema,
  });

  const citations = filterCitations(out.data.citations, events);
  const content = {
    kind: 'conversation_summary' as const,
    summary: out.data.summary,
    intent: out.data.intent,
    sentiment: out.data.sentiment,
    urgency: out.data.urgency,
    nextAction: out.data.nextAction,
  };

  const insight = await deps.db.aiInsight.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      ...(conversation.personRecordId ? { recordId: conversation.personRecordId } : {}),
      kind: 'SUMMARY',
      content: asJson(content),
      model: out.model,
      promptVersion: out.promptVersion,
      confidence: out.data.confidence,
      citations: asJson(citations),
      generatedAt: deps.now(),
    },
    select: { id: true },
  });

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'summary',
    model: out.model,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  });

  return {
    insightId: insight.id,
    content,
    citations,
    confidence: out.data.confidence,
    model: out.model,
    promptVersion: out.promptVersion,
  };
}

// ── §13.2 ────────────────────────────────────────────────────────────────────

export async function generateRelationshipBrief(
  deps: AiDeps,
  input: { workspaceId: string; recordId: string },
): Promise<AiInsightResult> {
  await gate(deps, input.workspaceId, 'relationship_brief');

  const record = await deps.db.record.findFirst({
    where: { id: input.recordId, deletedAt: null },
    select: { id: true },
  });
  if (!record) throw new NexusError('NOT_FOUND', { message: 'record not found' });

  const events = await personContext(deps.db, deps.settings, input.recordId);
  const platforms = [...new Set(events.map((e) => e.platform).filter((p): p is string => !!p))];

  const prompt = relationshipBriefPrompt({
    personLabel: `record ${input.recordId}`,
    platforms,
    events,
  });
  const out = await generateStructured(deps.model, {
    promptVersion: PROMPT_VERSIONS.relationship_brief,
    system: prompt.system,
    user: prompt.user,
    schema: relationshipBriefSchema,
  });

  const citations = filterCitations(out.data.citations, events);
  const content = {
    kind: 'relationship_brief' as const,
    summary: out.data.summary,
    caresAbout: out.data.caresAbout,
    openThreads: out.data.openThreads,
    riskFlags: out.data.riskFlags,
    platforms,
  };

  const insight = await deps.db.aiInsight.create({
    data: {
      workspaceId: input.workspaceId,
      recordId: input.recordId,
      kind: 'SUMMARY',
      content: asJson(content),
      model: out.model,
      promptVersion: out.promptVersion,
      confidence: out.data.confidence,
      citations: asJson(citations),
      generatedAt: deps.now(),
    },
    select: { id: true },
  });

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'relationship_brief',
    model: out.model,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  });

  return {
    insightId: insight.id,
    content,
    citations,
    confidence: out.data.confidence,
    model: out.model,
    promptVersion: out.promptVersion,
  };
}

// ── §13.4 ────────────────────────────────────────────────────────────────────

export async function draftReply(
  deps: AiDeps,
  input: {
    workspaceId: string;
    conversationId: string;
    maxLength?: number;
    instructions?: string;
  },
): Promise<{ text: string; promptVersion: string; citations: string[] }> {
  await gate(deps, input.workspaceId, 'reply_draft');

  const conversation = await deps.db.conversation.findFirst({
    where: { id: input.conversationId, deletedAt: null },
    select: {
      id: true,
      externalId: true,
      connectionId: true,
      identityId: true,
      personRecordId: true,
      platform: true,
      kind: true,
    },
  });
  if (!conversation) throw new NexusError('NOT_FOUND', { message: 'conversation not found' });

  const events = await conversationContext(deps.db, deps.settings, conversation);
  const base = {
    platform: conversation.platform,
    kind: conversation.kind,
    events,
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
  };

  const first = await generateStructured(deps.model, {
    promptVersion: PROMPT_VERSIONS.reply_draft,
    ...replyDraftPrompt(base),
    schema: replyDraftSchema,
  });

  let text = first.data.text.trim();
  let citations = filterCitations(first.data.citations, events);
  let promptTokens = first.promptTokens;
  let completionTokens = first.completionTokens;

  // The caller knows the platform's limit; we only have to respect it. One shorter attempt, then
  // a hard truncation rather than handing back something that cannot be sent.
  const max = input.maxLength;
  if (max !== undefined && text.length > max) {
    const retry = await generateStructured(deps.model, {
      promptVersion: PROMPT_VERSIONS.reply_draft,
      ...replyDraftPrompt({ ...base, shorterThan: max }),
      schema: replyDraftSchema,
    });
    promptTokens += retry.promptTokens;
    completionTokens += retry.completionTokens;
    const shorter = retry.data.text.trim();
    if (shorter.length <= max) {
      text = shorter;
      citations = filterCitations(retry.data.citations, events);
    } else {
      text = shorter.length < text.length ? shorter : text;
      text = text.slice(0, max).trimEnd();
      citations = filterCitations(retry.data.citations, events);
    }
  }

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: 'reply_draft',
    model: deps.model.name,
    promptTokens,
    completionTokens,
  });

  return { text, promptVersion: PROMPT_VERSIONS.reply_draft, citations };
}
