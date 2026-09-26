/**
 * AI layer (spec §13, ADR-021). Depends on `@nexus/core` and `@nexus/db` only — never on
 * `@nexus/sync`, `@nexus/connector-sdk` or `@nexus/mail` — so the same functions serve a human
 * clicking "regenerate brief" in `apps/web` and a queue job in `apps/worker`. Anything
 * platform-specific is injected by the caller through `AiDeps`.
 */
export const AI_PACKAGE = '@nexus/ai' as const;

// ── the provider seam ────────────────────────────────────────────────────────
export {
  EMBEDDING_DIMENSIONS,
  aiModelFromEnv,
  anthropicModel,
  contextIdsIn,
  deterministicVector,
  disabledModel,
  mockAiModel,
  openaiModel,
} from './model.ts';
export type {
  AiCompleteInput,
  AiCompleteResult,
  AiEmbedResult,
  AiModel,
  MockAiModel,
} from './model.ts';

// ── structured output ────────────────────────────────────────────────────────
export { extractJson, generateStructured } from './structured.ts';
export type { StructuredResult } from './structured.ts';

// ── the prompt registry ──────────────────────────────────────────────────────
export {
  PROMPT_VERSIONS,
  conversationSummaryPrompt,
  conversationSummarySchema,
  relationshipBriefPrompt,
  relationshipBriefSchema,
  renderContext,
  replyDraftPrompt,
  replyDraftSchema,
  researchAttributePrompt,
  researchSchemaFor,
} from './prompts.ts';
export type {
  ContextEvent,
  ConversationSummary,
  Prompt,
  PromptTask,
  RelationshipBrief,
  ReplyDraft,
} from './prompts.ts';

// ── PII redaction ────────────────────────────────────────────────────────────
export { redactPii } from './redact.ts';
export type { PiiRedactionLevel } from './redact.ts';

// ── kill switch, feature flags and the token budget ──────────────────────────
export {
  AI_FEATURES,
  aiSettingsFrom,
  assertAllowed,
  checkAiAllowed,
  loadAiSettings,
  recordAiUsage,
  startOfUtcMonth,
} from './budget.ts';
export type { AiAllowance, AiFeature, AiSettings } from './budget.ts';

// ── shared context helpers ───────────────────────────────────────────────────
export {
  CONTEXT_EVENT_LIMIT,
  conversationContext,
  filterCitations,
  payloadString,
  personContext,
  renderRecordValues,
} from './context.ts';
export type { AiDeps, AiInsightResult } from './context.ts';

// ── §13.1 / §13.2 / §13.4 ────────────────────────────────────────────────────
export { draftReply, generateRelationshipBrief, summarizeConversation } from './summary.ts';

// ── §13.3 ────────────────────────────────────────────────────────────────────
export { runResearchAttribute, writeAiResearchValue } from './research-attribute.ts';
export type { AiResearchConfig, AiResearchValue } from './research-attribute.ts';

// ── §13.5 ────────────────────────────────────────────────────────────────────
export {
  DEFAULT_LEAD_WEIGHTS,
  breadthValue,
  frequencyValue,
  pipelineValue,
  recencyValue,
  scoreLead,
} from './lead-score.ts';
export type { LeadFactor, LeadScore, LeadSignals } from './lead-score.ts';

// ── §13.6 / §13.7 ────────────────────────────────────────────────────────────
export { semanticSearch } from './search.ts';
export {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  bioEmbeddingSimilarity,
  chunkText,
  cosineSimilarity,
  embedAndStore,
} from './embed.ts';
