import { describe, expect, it } from 'vitest';
import {
  CANONICAL_KINDS,
  canonicalConversionSchema,
  canonicalEntitySchema,
  canonicalMessageSchema,
  canonicalPersonSchema,
  type CanonicalEntity,
  type CanonicalKind,
} from './canonical.ts';

const base = {
  platform: 'MOCK',
  externalId: 'ext-1',
  occurredAt: '2026-09-24T10:00:00.000Z',
  sourceUrl: 'https://mock.example/objects/ext-1',
  raw: { id: 'ext-1' },
} as const;

/** One valid fixture per canonical kind. */
const fixtures: Record<CanonicalKind, Record<string, unknown>> = {
  person: {
    ...base,
    kind: 'person',
    handle: 'acmehq',
    displayName: 'Acme HQ',
    avatarUrl: 'https://cdn.mock.example/a.png',
    profileUrl: 'https://mock.example/acmehq',
    email: 'hello@acme.com',
    phone: '+442071234567',
    followerCount: 1200,
    timezone: 'Europe/London',
  },
  company: {
    ...base,
    kind: 'company',
    name: 'Acme Ltd',
    handle: 'acme',
    domain: 'acme.com',
    logoUrl: null,
    profileUrl: null,
  },
  conversation: {
    ...base,
    kind: 'conversation',
    conversationType: 'dm',
    participants: [{ externalId: 'u1', handle: 'u1', displayName: 'U One', role: 'customer' }],
    subject: null,
    status: 'open',
    lastMessageAt: '2026-09-24T09:59:00.000Z',
    replyWindowExpiresAt: '2026-09-25T09:59:00.000Z',
    rootExternalId: null,
  },
  message: {
    ...base,
    kind: 'message',
    conversationExternalId: 'conv-1',
    messageType: 'dm',
    direction: 'inbound',
    authorExternalId: 'u1',
    body: 'hi there',
    attachments: [{ type: 'image', url: 'https://cdn.mock.example/x.jpg' }],
    sentAt: '2026-09-24T09:59:00.000Z',
    replyWindowExpiresAt: '2026-09-25T09:59:00.000Z',
    parentExternalId: null,
    rootExternalId: null,
  },
  post: {
    ...base,
    kind: 'post',
    authorExternalId: 'acct-1',
    postType: 'original',
    mediaType: 'image',
    body: 'launch day',
    media: [],
    publishedAt: '2026-09-24T08:00:00.000Z',
    parentExternalId: null,
    rootExternalId: null,
    stats: { likes: 10 },
  },
  engagement: {
    ...base,
    kind: 'engagement',
    engagementType: 'like',
    targetKind: 'post',
    targetExternalId: 'post-1',
    actorExternalId: 'u1',
  },
  lead: {
    ...base,
    kind: 'lead',
    source: 'lead_form',
    formExternalId: 'form-1',
    submittedAt: '2026-09-24T10:00:00.000Z',
    fields: [{ name: 'email', value: 'jo@example.com' }],
    email: 'jo@example.com',
  },
  review: {
    ...base,
    kind: 'review',
    authorExternalId: 'u1',
    authorDisplayName: 'Jo',
    rating: 4,
    body: 'good',
    reviewedAt: '2026-09-24T10:00:00.000Z',
    reply: null,
  },
  metric: {
    ...base,
    kind: 'metric',
    subjectKind: 'post',
    subjectExternalId: 'post-1',
    metric: 'impressions',
    value: 1234,
    period: {
      start: '2026-09-23T00:00:00.000Z',
      end: '2026-09-24T00:00:00.000Z',
      granularity: 'day',
    },
  },
  conversion: {
    ...base,
    platform: 'KEITARO',
    kind: 'conversion',
    subid: 'click-abc',
    tid: 'tx-1',
    status: 'sale',
    payout: 12.5,
    currency: 'USD',
    subIds: { sub_id_1: 'fb', sub_id_2: null },
    campaign: { externalId: '7', name: 'Summer' },
    source: null,
    offer: { externalId: '3', name: 'Offer A' },
    affiliateNetwork: null,
    stream: null,
    landing: null,
    geo: { country: 'GB' },
    device: { type: 'mobile' },
    creative: null,
    clickedAt: '2026-09-24T09:00:00.000Z',
    postbackAt: '2026-09-24T10:00:00.000Z',
  },
};

describe('canonical entity schemas', () => {
  it.each(CANONICAL_KINDS)('accepts a valid %s fixture', (kind) => {
    const result = canonicalEntitySchema.safeParse(fixtures[kind]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    if (result.success) {
      const entity: CanonicalEntity = result.data;
      expect(entity.kind).toBe(kind);
      expect(entity.occurredAt).toBeInstanceOf(Date);
    }
  });

  it('coerces ISO strings on occurredAt and keeps sourceUrl nullable', () => {
    const parsed = canonicalPersonSchema.parse({ ...fixtures.person, sourceUrl: null });
    expect(parsed.occurredAt.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(parsed.sourceUrl).toBeNull();
  });

  it('rejects a payload whose kind does not match its fields', () => {
    // person-shaped fields, but labelled as a message
    const wrongKind = { ...fixtures.person, kind: 'message' };
    expect(canonicalEntitySchema.safeParse(wrongKind).success).toBe(false);
    expect(canonicalMessageSchema.safeParse(wrongKind).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(canonicalEntitySchema.safeParse({ ...fixtures.person, kind: 'alien' }).success).toBe(
      false,
    );
  });

  it('rejects a non-E.164 phone on a person', () => {
    expect(
      canonicalPersonSchema.safeParse({ ...fixtures.person, phone: '020 7123 4567' }).success,
    ).toBe(false);
  });
});

describe('CanonicalConversion (Keitaro)', () => {
  it('accepts a negative payout (chargeback)', () => {
    const parsed = canonicalConversionSchema.parse({
      ...fixtures.conversion,
      status: 'rejected',
      payout: -12.5,
    });
    expect(parsed.payout).toBe(-12.5);
  });

  it('accepts a user-defined custom status', () => {
    expect(
      canonicalConversionSchema.safeParse({ ...fixtures.conversion, status: 'upsell' }).success,
    ).toBe(true);
  });

  it('rejects an empty status and an unknown sub_id key', () => {
    expect(
      canonicalConversionSchema.safeParse({ ...fixtures.conversion, status: '' }).success,
    ).toBe(false);
    expect(
      canonicalConversionSchema.safeParse({ ...fixtures.conversion, subIds: { sub_id_31: 'x' } })
        .success,
    ).toBe(false);
  });
});
