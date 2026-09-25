import { z } from 'zod';

/**
 * Every platform Nexus can connect to. This list is mirrored one-for-one by the
 * Prisma `Platform` enum in `@nexus/db` — keep the two identical, in this order.
 *
 * `MOCK` is the local fake platform used by the contract test suite, the seed
 * data and the backfill throughput benchmark (spec §3, §16).
 */
export const PLATFORMS = [
  'FACEBOOK',
  'INSTAGRAM',
  'X',
  'LINKEDIN',
  'TIKTOK',
  'YOUTUBE',
  'GMAIL',
  'GOOGLE_CALENDAR',
  'GOOGLE_BUSINESS',
  'KEITARO',
  'MOCK',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

/** Display names for connection labels and the UI. */
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  GMAIL: 'Gmail',
  GOOGLE_CALENDAR: 'Google Calendar',
  GOOGLE_BUSINESS: 'Google Business Profile',
  KEITARO: 'Keitaro',
  MOCK: 'Mock Platform',
};
