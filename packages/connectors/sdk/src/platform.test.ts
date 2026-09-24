import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitySchema } from './capability.ts';
import { PLATFORMS, platformSchema } from './platform.ts';

describe('PLATFORMS', () => {
  it('contains KEITARO and MOCK', () => {
    expect(PLATFORMS).toContain('KEITARO');
    expect(PLATFORMS).toContain('MOCK');
  });

  it('matches the Prisma enum list exactly', () => {
    expect([...PLATFORMS]).toEqual([
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
    ]);
    expect(platformSchema.safeParse('TWITTER').success).toBe(false);
  });
});

describe('CAPABILITIES', () => {
  it('has the 17 capabilities from §7.1 and rejects others', () => {
    expect(CAPABILITIES).toHaveLength(17);
    expect(capabilitySchema.safeParse('write:reply_dm').success).toBe(true);
    expect(capabilitySchema.safeParse('write:send_email').success).toBe(false);
  });
});
