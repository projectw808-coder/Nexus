import { z } from 'zod';
import { resourceIdSchema } from './manifest.ts';
import { SUB_ID_KEYS } from './canonical.ts';

/**
 * Per-connection settings (spec §7.4) — the JSON stored in `Connection.settings`
 * and handed to connectors as `ConnCtx.settings`. Everything here is the
 * user's choice for THIS connection; connector defaults come from the manifest.
 */

export const resourceSettingSchema = z.object({
  enabled: z.boolean(),
  /** Overrides `ResourceDescriptor.defaultIntervalSeconds`. */
  intervalSeconds: z.number().int().positive().optional(),
  /** Whether the webhook subscription for this resource is active. */
  webhook: z.boolean().optional(),
});

export const businessHoursSchema = z.object({
  timezone: z.string().min(1),
  /** `0` = Sunday … `6` = Saturday; `HH:MM` 24h local. */
  windows: z.array(
    z.object({
      day: z.number().int().min(0).max(6),
      open: z.string().regex(/^\d{2}:\d{2}$/),
      close: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ),
});

/** What a Keitaro `sub_id_N` holds, for §10 identity resolution. Only mapped, populated fields feed the resolver. */
export const subIdMeaningSchema = z.enum([
  'email',
  'phone',
  'external_crm_id',
  'affiliate_lead_id',
  'ignore',
]);

export const connectionSettingsSchema = z.object({
  /** Resource toggles and per-resource intervals, keyed by `ResourceDescriptor.id`. */
  resources: z.record(resourceIdSchema, resourceSettingSchema).default({}),
  backfillDays: z.number().int().positive().default(90),
  overlapSeconds: z.number().int().nonnegative().default(300),
  /** Pinned API version override; `null` = use the manifest's. */
  apiVersion: z.string().nullable().default(null),
  fieldMappingId: z.string().nullable().default(null),
  autoCreatePersonOnInbound: z.boolean().default(true),
  assignmentRuleId: z.string().nullable().default(null),
  slaTargetMinutes: z.number().int().positive().nullable().default(null),
  businessHours: businessHoursSchema.nullable().default(null),
  awayMessage: z.string().nullable().default(null),
  filters: z
    .object({
      profanity: z.boolean().default(false),
      spam: z.boolean().default(false),
    })
    .default({ profanity: false, spam: false }),
  retentionDays: z.number().int().positive().nullable().default(null),
  /** Free-text declaration of the customer's platform plan, fed to the quota simulator. */
  rateLimitTier: z.string().nullable().default(null),
  /** Sandbox / dry-run: `execute()` must not reach the platform. */
  dryRun: z.boolean().default(false),
  paused: z.boolean().default(false),
  /** Required for `metered_credits` connectors (X): monthly cap and alert threshold in rate-card units. */
  spendCap: z
    .object({
      monthlyCapUnits: z.number().positive(),
      alertThresholdFraction: z.number().gt(0).lte(1).default(0.8),
    })
    .nullable()
    .default(null),
  /** Self-hosted platforms (Keitaro): per-connection base URL, HTTPS required. */
  baseUrl: z.url().nullable().default(null),
  /** Optional pinned CA / self-signed certificate (PEM) for `baseUrl`. */
  caCertPem: z.string().nullable().default(null),
  /** Client-side limiter for platforms with no published limit (Keitaro default 2 rps / 2 concurrent). */
  clientLimiter: z
    .object({
      requestsPerSecond: z.number().positive().default(2),
      maxConcurrent: z.number().int().positive().default(2),
    })
    .nullable()
    .default(null),
  /** Keitaro sub_id mapping UI (§8.6). */
  subIdMapping: z.partialRecord(z.enum(SUB_ID_KEYS), subIdMeaningSchema).default({}),
  /** Keitaro `clicks`: only sync clicks with a conversion unless the user defines a filter. */
  clickFilter: z
    .object({
      convertedOnly: z.boolean().default(true),
      sampleFraction: z.number().gt(0).lte(1).optional(),
      campaignExternalIds: z.array(z.string()).optional(),
    })
    .nullable()
    .default(null),
});

export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
/** The shape before defaults are applied — what the settings form submits. */
export type ConnectionSettingsInput = z.input<typeof connectionSettingsSchema>;
