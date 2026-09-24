import type { Env } from './env.ts';

/**
 * Feature flags. Boot-level flags come from env; workspace-level overrides (Workspace.settings)
 * are layered on top by the caller so a flag can be on for one tenant during rollout.
 */
export const FEATURE_FLAGS = ['gmail', 'ads', 'mockPlatform'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export type FlagOverrides = Partial<Record<FeatureFlag, boolean>>;

export function flagsFromEnv(env: Env): Record<FeatureFlag, boolean> {
  return {
    gmail: env.FEATURE_GMAIL,
    ads: env.FEATURE_ADS,
    mockPlatform: env.FEATURE_MOCK_PLATFORM,
  };
}

export function isEnabled(flag: FeatureFlag, env: Env, overrides: FlagOverrides = {}): boolean {
  return overrides[flag] ?? flagsFromEnv(env)[flag];
}
