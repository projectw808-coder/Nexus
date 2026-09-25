import { z } from 'zod';
import { capabilitySchema } from './capability.ts';
import { platformSchema } from './platform.ts';
import { laneSchema, quotaModelSchema } from './quota.ts';

/**
 * Resource ids are `<platform-prefix>.<resource>`, e.g. `ig.comments`,
 * `x.mentions`, `keitaro.conversions`. They are the `SyncCursor.resource` key
 * and the toggle key in `Connection.settings.resources`.
 */
export const resourceIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, 'resource ids look like "ig.comments"');

/**
 * Describes one syncable resource a connector exposes. Everything the sync
 * engine, the settings page and the quota simulator need to schedule it lives
 * here — the connector never schedules itself.
 */
export const resourceDescriptorSchema = z.object({
  id: resourceIdSchema,
  displayName: z.string().min(1),
  /** `ExternalObject.kind` values this resource yields (e.g. `ig_comment`, `x_dm`). */
  kinds: z.array(z.string().min(1)).min(1),
  /** Default delta poll interval; overridable per connection (§7.4). */
  defaultIntervalSeconds: z.number().int().positive(),
  /** Whether a fresh connection syncs this resource without the user opting in. */
  defaultEnabled: z.boolean(),
  supportsBackfill: z.boolean(),
  supportsWebhook: z.boolean(),
  /**
   * Budget cost of fetching one page, in the units of the connector's
   * `QuotaModel` (calls, YouTube units or credits). The quota simulator
   * multiplies this by projected page counts.
   */
  costPerPage: z.number().nonnegative(),
  /** Lane hints for the scheduler. Keitaro `clicks`/`conversions` backfills exclude `interactive`. */
  laneHints: z.object({
    defaultLane: laneSchema,
    allowedLanes: z.array(laneSchema).min(1),
  }),
  /** Overlap re-queried on timestamp-only cursors; defaults to `SyncCursor.overlapSeconds`. */
  overlapSeconds: z.number().int().nonnegative().optional(),
  /** Human-readable warning rendered next to the toggle (e.g. "very high volume — off by default"). */
  warning: z.string().optional(),
});

export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;

export const authKindSchema = z.enum(['oauth2', 'oauth2_pkce', 'oauth1a', 'api_key']);
export type AuthKind = z.infer<typeof authKindSchema>;

export const webhookVerificationSchema = z.enum(['hmac_sha256', 'jwt', 'shared_secret', 'none']);
export type WebhookVerification = z.infer<typeof webhookVerificationSchema>;

export const scopeDescriptorSchema = z.object({
  /** The scope string exactly as the platform expects it (`instagram_manage_comments`). */
  id: z.string().min(1),
  /** What the user is granting, in their language — rendered on the consent checklist. */
  plainLanguage: z.string().min(1),
  /** Capabilities that are degraded when this scope is missing. */
  requiredFor: z.array(capabilitySchema),
  /** Requires App Review / Business Verification / restricted-scope verification. */
  sensitive: z.boolean(),
});

export type ScopeDescriptor = z.infer<typeof scopeDescriptorSchema>;

/**
 * `ConnectorManifest` exactly as spec §7.1. It is static, pure data: the UI
 * renders it, the sync engine schedules from it, the limiter is configured by
 * it. The API version is pinned here and NOWHERE else in the connector.
 */
export const connectorManifestSchema = z
  .object({
    platform: platformSchema,
    displayName: z.string().min(1),
    /** Pinned platform API version, surfaced in the UI (Meta `v26.0`, LinkedIn `202609`). */
    apiVersion: z.string().min(1),
    docsUrl: z.url(),
    authKind: authKindSchema,
    scopes: z.array(scopeDescriptorSchema),
    resources: z.array(resourceDescriptorSchema),
    capabilities: z.array(capabilitySchema),
    quota: quotaModelSchema,
    webhooks: z.object({
      supported: z.boolean(),
      verification: webhookVerificationSchema,
      /** Resource ids that can be webhook-fed; each still gets a reconciliation poll (§9.1). */
      resources: z.array(resourceIdSchema),
      /** Can the platform re-deliver missed events on request? */
      replayable: z.boolean(),
    }),
    /** Human-readable gotchas rendered in the UI ("URL-bearing posts cost 13x"). */
    constraints: z.array(z.string()),
    /** What the customer's API plan / app-review status must be. */
    tierNotes: z.string(),
    /** Response header the platform echoes its API version in, for the served-version drift check (§8.1). */
    apiVersionHeader: z.string().min(1).optional(),
    /** Messaging-window rule enforced in `preflight()` (Meta: 24 hours after the customer's last message). */
    messagingWindowHours: z.number().positive().optional(),
  })
  .superRefine((m, ctx) => {
    const resourceIds = new Set<string>();
    m.resources.forEach((r, i) => {
      if (resourceIds.has(r.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', i, 'id'],
          message: `duplicate resource id "${r.id}"`,
        });
      }
      resourceIds.add(r.id);
      if (!r.laneHints.allowedLanes.includes(r.laneHints.defaultLane)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', i, 'laneHints', 'defaultLane'],
          message: 'defaultLane must be one of allowedLanes',
        });
      }
    });

    const declared = new Set<string>(m.capabilities);
    m.scopes.forEach((s, i) => {
      s.requiredFor.forEach((cap, j) => {
        if (!declared.has(cap)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scopes', i, 'requiredFor', j],
            message: `scope "${s.id}" is required for "${cap}" but the manifest does not declare that capability`,
          });
        }
      });
    });

    m.webhooks.resources.forEach((id, i) => {
      if (!resourceIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['webhooks', 'resources', i],
          message: `webhook resource "${id}" is not a declared resource`,
        });
      }
    });
    if (!m.webhooks.supported && m.webhooks.resources.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['webhooks', 'resources'],
        message: 'webhooks.supported is false',
      });
    }
  });

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
