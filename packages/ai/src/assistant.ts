/**
 * The AI assistant (admin-only): create/edit Client records and answer integration questions
 * through a chat interface. Unlike the other §13 features, its output can trigger a write — the
 * caller (apps/web/server/routers/assistant.ts) executes the returned `action` itself, through
 * the same createRecord/updateRecord path and audit trail a manual edit would use, and re-checks
 * the `clientId` on an update against the ids it actually offered in context.
 */
import { assertAllowed, checkAiAllowed, recordAiUsage, type AiFeature } from './budget.ts';
import type { AiDeps } from './context.ts';
import {
  assistantPrompt,
  assistantResponseSchema,
  PROMPT_VERSIONS,
  type AssistantAction,
  type AssistantClientContext,
  type AssistantIntegrationContext,
} from './prompts.ts';
import { generateStructured } from './structured.ts';

export type AssistantResult = {
  reply: string;
  action: AssistantAction;
  model: string;
  promptVersion: string;
};

const FEATURE: AiFeature = 'assistant';

export async function runAssistant(
  deps: AiDeps,
  input: {
    workspaceId: string;
    message: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    clients: AssistantClientContext[];
    integrations: AssistantIntegrationContext[];
  },
): Promise<AssistantResult> {
  assertAllowed(
    await checkAiAllowed(deps.db, input.workspaceId, FEATURE, deps.settings, { now: deps.now() }),
    FEATURE,
  );

  const prompt = assistantPrompt({
    message: input.message,
    history: input.history,
    clients: input.clients,
    integrations: input.integrations,
  });
  const out = await generateStructured(deps.model, {
    promptVersion: PROMPT_VERSIONS.assistant,
    system: prompt.system,
    user: prompt.user,
    schema: assistantResponseSchema,
    maxTokens: 600,
  });

  // A hallucinated clientId is downgraded to "none" here rather than trusted — the router's own
  // re-check before executing is the real guard, but failing closed at both layers costs nothing.
  const proposed = out.data.action;
  const action: AssistantAction =
    proposed.tool === 'update_client' && !input.clients.some((c) => c.id === proposed.clientId)
      ? { tool: 'none' }
      : proposed;

  await recordAiUsage(deps.db, {
    workspaceId: input.workspaceId,
    feature: FEATURE,
    model: out.model,
    promptTokens: out.promptTokens,
    completionTokens: out.completionTokens,
  });

  return {
    reply: out.data.reply,
    action,
    model: out.model,
    promptVersion: out.promptVersion,
  };
}
