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
  assistant: 'v1',
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
    `You are Pantera CRM's ${role}. You work only from the CONTEXT you are given.`,
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

// ── AI assistant (admin-only: create/edit clients, integration guidance) ────

/** A client record already in the workspace, given as context so the model can reference a real
 * id instead of inventing one when the admin asks it to edit "that lead" or a name. */
export type AssistantClientContext = {
  id: string;
  name: string;
  email: string | null;
  status: string | null;
};

export type AssistantIntegrationContext = {
  platform: string;
  connected: boolean;
};

export const assistantActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('none') }),
  z.object({
    tool: z.literal('create_client'),
    name: z.string().min(1).max(200),
    email: z.string().max(320).optional(),
    phone: z.string().max(40).optional(),
    status: z.string().max(60).optional(),
    campaign: z.string().max(200).optional(),
    source: z.string().max(200).optional(),
  }),
  z.object({
    tool: z.literal('update_client'),
    // Must be one of the ids given in CLIENTS context — the caller re-validates this and
    // refuses an id it did not offer, so a hallucinated one is rejected, not silently applied.
    clientId: z.string().min(1),
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    phone: z.string().max(40).optional(),
    status: z.string().max(60).optional(),
    campaign: z.string().max(200).optional(),
    source: z.string().max(200).optional(),
  }),
]);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

export const assistantResponseSchema = z.object({
  reply: z.string().min(1).max(2000),
  action: assistantActionSchema,
});
export type AssistantResponse = z.infer<typeof assistantResponseSchema>;

export function assistantPrompt(input: {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  clients: AssistantClientContext[];
  integrations: AssistantIntegrationContext[];
}): Prompt {
  const system = [
    '# task: assistant',
    "You are Pantera CRM's admin assistant. You help an OWNER or ADMIN create and edit Client",
    'records, and answer questions about connecting integrations. You are not shown to other',
    'roles, so you may discuss integration status freely.',
    '',
    JSON_RULE,
    '',
    'Shape:',
    '{ "reply": string, "action": ' +
      '{ "tool": "none" } | ' +
      '{ "tool": "create_client", "name": string, "email"?, "phone"?, "status"?, "campaign"?, "source"? } | ' +
      '{ "tool": "update_client", "clientId": string, "name"?, "email"?, "phone"?, "status"?, "campaign"?, "source"? } }',
    '',
    'Rules:',
    '- Use "create_client" only when the admin clearly asked to add a new client, and "name" is',
    '  the one piece you must always have (ask a follow-up question in "reply" and use tool',
    '  "none" if it is missing).',
    '- Use "update_client" only with a `clientId` copied EXACTLY from the CLIENTS list below —',
    '  never invent one. If the admin refers to someone not in that list, say so in "reply" and',
    '  use tool "none" rather than guessing an id.',
    '- Only set the fields the admin actually asked to change; leave the rest out.',
    '- "status" is free text but should match the pipeline stages already in use',
    '  (new, contacted, qualified, won, lost) unless the admin asks for something else.',
    '- For integration questions, answer from the INTEGRATIONS list below. You cannot connect a',
    '  platform yourself (that needs the admin to complete an OAuth flow in Settings →',
    '  Integrations) — tell them to go there, and mention what is already connected.',
    '- Keep "reply" short and conversational. Never fabricate a client, a status, or a',
    '  connection that is not in the context below.',
  ].join('\n');

  const clientLines = input.clients.length
    ? input.clients
        .map(
          (c) =>
            `id: ${c.id} | name: ${c.name} | email: ${c.email ?? '—'} | status: ${c.status ?? '—'}`,
        )
        .join('\n')
    : '(no clients yet)';

  const integrationLines = input.integrations.length
    ? input.integrations
        .map((i) => `${i.platform}: ${i.connected ? 'connected' : 'not connected'}`)
        .join('\n')
    : '(no integrations configured)';

  const historyLines = input.history
    .slice(-10)
    .map((h) => `${h.role === 'user' ? 'Admin' : 'Assistant'}: ${h.content}`)
    .join('\n');

  const user = [
    'CLIENTS (most recently updated first):',
    clientLines,
    '',
    'INTEGRATIONS:',
    integrationLines,
    ...(historyLines ? ['', 'RECENT CONVERSATION:', historyLines] : []),
    '',
    `Admin: ${input.message}`,
  ].join('\n');

  return { system, user };
}
