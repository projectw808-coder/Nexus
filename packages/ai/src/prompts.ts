/**
 * The versioned prompt registry (spec §13: "a versioned prompt registry — `promptVersion` stored
 * on every output"). Every prompt is short, demands JSON-only output, and spells out the citation
 * rule: cite the `id:` of the timeline events in the context block, never an invented one.
 *
 * Each system prompt carries a machine-readable `# task:` line. `mockAiModel()`'s default reads it
 * to pick a realistically-shaped canned reply, so tests that do not care what the model "said"
 * still exercise real Zod validation.
 */
import { z } from 'zod';

export const PROMPT_VERSIONS = {
  conversation_summary: 'v1',
  relationship_brief: 'v1',
  research_attribute: 'v1',
  reply_draft: 'v1',
} as const;

export type PromptTask = keyof typeof PROMPT_VERSIONS;

export type Prompt = { system: string; user: string };

/** One timeline event as the model sees it. `id` is the literal `TimelineEvent.id`. */
export type ContextEvent = {
  id: string;
  occurredAt: Date;
  type: string;
  platform: string | null;
  /** Already PII-redacted. */
  text: string;
};

const CITATION_RULE = [
  'Cite your evidence: for every event in the CONTEXT block you actually drew on, put its `id:`',
  'value into the `citations` array. Use the ids exactly as written. Never invent an id, and never',
  'cite an id that is not in the CONTEXT block. If no event supports a claim, leave citations empty.',
].join(' ');

const JSON_RULE =
  'Respond with ONLY a single JSON object matching the shape below. No prose, no markdown fence, no commentary.';

function systemFor(task: PromptTask, role: string, shape: string): string {
  return [
    `# task: ${task}`,
    `You are Nexus CRM's ${role}. You work only from the CONTEXT you are given.`,
    '',
    JSON_RULE,
    '',
    'Shape:',
    shape,
    '',
    CITATION_RULE,
    'Personal data has already been redacted; do not try to reconstruct it.',
  ].join('\n');
}

export function renderContext(events: ContextEvent[]): string {
  if (!events.length) return '(no timeline events)';
  return events
    .map(
      (e) =>
        `- id: ${e.id} | ${e.occurredAt.toISOString()} | ${e.type}${
          e.platform ? ` on ${e.platform}` : ''
        } | ${e.text.replace(/\s+/g, ' ').slice(0, 800)}`,
    )
    .join('\n');
}

// ── §13.1 conversation summary ───────────────────────────────────────────────

export const conversationSummarySchema = z.object({
  summary: z.string().min(1).max(2000),
  intent: z.enum(['support', 'sales', 'complaint', 'partnership', 'spam', 'other']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  urgency: z.enum(['low', 'medium', 'high']),
  nextAction: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  citations: z.array(z.string()).default([]),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export function conversationSummaryPrompt(input: {
  platform: string;
  kind: string;
  events: ContextEvent[];
}): Prompt {
  return {
    system: systemFor(
      'conversation_summary',
      'conversation analyst',
      [
        '{ "summary": string, "intent": "support"|"sales"|"complaint"|"partnership"|"spam"|"other",',
        '  "sentiment": "positive"|"neutral"|"negative", "urgency": "low"|"medium"|"high",',
        '  "nextAction": string, "confidence": number between 0 and 1, "citations": string[] }',
      ].join('\n'),
    ),
    user: [
      `Conversation: a ${input.kind} thread on ${input.platform}.`,
      'Summarise it, detect the intent, sentiment and urgency, and suggest the single best next action.',
      '',
      'CONTEXT (most recent first):',
      renderContext(input.events),
    ].join('\n'),
  };
}

// ── §13.2 relationship brief ─────────────────────────────────────────────────

export const relationshipBriefSchema = z.object({
  summary: z.string().min(1).max(2000),
  caresAbout: z.array(z.string().max(200)).max(10).default([]),
  openThreads: z.array(z.string().max(300)).max(10).default([]),
  riskFlags: z.array(z.string().max(200)).max(10).default([]),
  confidence: z.number().min(0).max(1),
  citations: z.array(z.string()).default([]),
});
export type RelationshipBrief = z.infer<typeof relationshipBriefSchema>;

export function relationshipBriefPrompt(input: {
  personLabel: string;
  platforms: string[];
  events: ContextEvent[];
}): Prompt {
  return {
    system: systemFor(
      'relationship_brief',
      'relationship analyst',
      [
        '{ "summary": string, "caresAbout": string[], "openThreads": string[],',
        '  "riskFlags": string[], "confidence": number between 0 and 1, "citations": string[] }',
      ].join('\n'),
    ),
    user: [
      `Person: ${input.personLabel}.`,
      `Channels seen: ${input.platforms.length ? input.platforms.join(', ') : 'none recorded'}.`,
      'Write a rolling brief: what they care about, what is still open, and any risk flags.',
      '',
      'CONTEXT (most recent first, across every channel):',
      renderContext(input.events),
    ].join('\n'),
  };
}

// ── §13.3 AI research attribute ──────────────────────────────────────────────

const sourceSchema = z.object({ url: z.url(), title: z.string().max(300).optional() });

/** The output schema depends on the attribute's declared `outputType` (a typed, filterable value). */
export function researchSchemaFor(
  outputType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT',
  options?: { id: string; label: string }[],
) {
  const value =
    outputType === 'NUMBER'
      ? z.number().finite().nullable()
      : outputType === 'BOOLEAN'
        ? z.boolean().nullable()
        : outputType === 'SELECT'
          ? z
              .string()
              .nullable()
              .refine(
                (v) => v === null || (options ?? []).some((o) => o.id === v),
                'must be one of the allowed option ids',
              )
          : z.string().max(4000).nullable();
  return z.object({
    value,
    sources: z.array(sourceSchema).max(10).default([]),
    confidence: z.number().min(0).max(1).optional(),
    citations: z.array(z.string()).default([]),
  });
}

export function researchAttributePrompt(input: {
  question: string;
  outputType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT';
  options?: { id: string; label: string }[];
  recordSummary: string;
  events: ContextEvent[];
}): Prompt {
  const valueShape =
    input.outputType === 'NUMBER'
      ? 'number or null'
      : input.outputType === 'BOOLEAN'
        ? 'true, false or null'
        : input.outputType === 'SELECT'
          ? `one of these option ids (or null): ${(input.options ?? []).map((o) => `"${o.id}" (${o.label})`).join(', ') || 'none defined'}`
          : 'a short string or null';
  return {
    system: systemFor(
      'research_attribute',
      'research agent',
      [
        `{ "value": ${valueShape}, "sources": [{ "url": string, "title"?: string }],`,
        '  "confidence"?: number between 0 and 1, "citations": string[] }',
      ].join('\n'),
    ),
    user: [
      `Question: ${input.question}`,
      'Answer with a single typed value, not prose. Use null when the evidence does not support an answer.',
      'Put any web sources you relied on in `sources`; timeline evidence goes in `citations`.',
      '',
      'RECORD:',
      input.recordSummary || '(no values)',
      '',
      'CONTEXT (most recent first):',
      renderContext(input.events),
    ].join('\n'),
  };
}

// ── §13.4 reply drafting ─────────────────────────────────────────────────────

export const replyDraftSchema = z.object({
  text: z.string().min(1).max(8000),
  citations: z.array(z.string()).default([]),
});
export type ReplyDraft = z.infer<typeof replyDraftSchema>;

export function replyDraftPrompt(input: {
  platform: string;
  kind: string;
  maxLength?: number;
  instructions?: string;
  events: ContextEvent[];
  /** Set on the corrective pass when the first draft ran long. */
  shorterThan?: number;
}): Prompt {
  return {
    system: systemFor('reply_draft', 'reply drafter', '{ "text": string, "citations": string[] }'),
    user: [
      `Draft one reply for a ${input.kind} thread on ${input.platform}.`,
      input.maxLength ? `Hard limit: ${input.maxLength} characters.` : '',
      input.shorterThan
        ? `Your previous draft was too long. Rewrite it shorter, under ${input.shorterThan} characters.`
        : '',
      input.instructions ? `Author's instructions: ${input.instructions}` : '',
      "Match the thread's tone. Do not invent facts, prices or commitments. Never promise a date the context does not support.",
      '',
      'CONTEXT (most recent first):',
      renderContext(input.events),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
