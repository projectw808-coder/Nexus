import { z } from 'zod';

/**
 * The capability vocabulary from spec §7.1. A connector declares the subset it
 * implements in its manifest; `verifyScopes()` reports which of those are
 * currently degraded because a scope was not granted, and `SCOPE_MISSING`
 * failures disable exactly one capability rather than the whole connection.
 *
 * Read capabilities gate ingest resources; write capabilities gate
 * `OutboundActionInput.kind` values a connector will accept in `execute()`.
 */
export const CAPABILITIES = [
  'read:profile',
  'read:messages',
  'read:comments',
  'read:mentions',
  'read:posts',
  'read:insights',
  'read:leads',
  'read:reviews',
  'read:followers',
  'read:ads',
  'write:reply_dm',
  'write:reply_comment',
  'write:publish_post',
  'write:hide_comment',
  'write:delete_comment',
  'write:react',
  'write:follow',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const capabilitySchema = z.enum(CAPABILITIES);

/** Convenience narrowing for the two halves of the vocabulary. */
export type ReadCapability = Extract<Capability, `read:${string}`>;
export type WriteCapability = Extract<Capability, `write:${string}`>;
