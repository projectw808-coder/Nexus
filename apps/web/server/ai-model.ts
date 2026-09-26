/**
 * Process-wide `AiModel` handle (Phase 10, ADR-021), cached on `globalThis` so Next's HMR does
 * not rebuild it per reload — mirrors `./sync.ts`'s `getSyncDeps`.
 */
import { aiModelFromEnv, type AiModel } from '@nexus/ai';
import { loadEnv } from '@nexus/config';

const g = globalThis as unknown as { __nexusAiModel?: AiModel };

export function getAiModel(): AiModel {
  g.__nexusAiModel ??= aiModelFromEnv({
    AI_PROVIDER: loadEnv().AI_PROVIDER,
    AI_API_KEY: loadEnv().AI_API_KEY,
  });
  return g.__nexusAiModel;
}
