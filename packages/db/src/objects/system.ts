/**
 * System object types (ADR-001): Person, Company and Deal are ObjectType rows seeded into every
 * new workspace with protected attributes. §10 Tier-1 matching depends on the slugs below
 * (`email`, `phone`, `name`, `domain`), so they are `isSystem` and cannot be deleted or retyped.
 */
import type { AttributeType } from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { SystemDb } from '../scoped.ts';

type SeedAttribute = {
  apiSlug: string;
  title: string;
  type: AttributeType;
  config?: Record<string, unknown>;
  isRequired?: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
};

type SeedObject = {
  apiSlug: string;
  singular: string;
  plural: string;
  icon: string;
  attributes: SeedAttribute[];
};

export const DEAL_STAGES = [
  { id: 'lead', label: 'Lead', category: 'open' },
  { id: 'qualified', label: 'Qualified', category: 'open' },
  { id: 'proposal', label: 'Proposal', category: 'open' },
  { id: 'negotiation', label: 'Negotiation', category: 'open' },
  { id: 'won', label: 'Won', category: 'won' },
  { id: 'lost', label: 'Lost', category: 'lost' },
] as const;

export const SYSTEM_OBJECTS: SeedObject[] = [
  {
    apiSlug: 'person',
    singular: 'Person',
    plural: 'People',
    icon: 'user',
    attributes: [
      { apiSlug: 'name', title: 'Name', type: 'TEXT', isRequired: true, isIndexed: true },
      { apiSlug: 'email', title: 'Email', type: 'EMAIL', isUnique: true, isIndexed: true },
      { apiSlug: 'phone', title: 'Phone', type: 'PHONE', isIndexed: true },
      { apiSlug: 'title', title: 'Job title', type: 'TEXT' },
      {
        apiSlug: 'company',
        title: 'Company',
        type: 'RELATIONSHIP',
        config: { targetObjectTypeId: '$company', multiple: false },
      },
      { apiSlug: 'location', title: 'Location', type: 'LOCATION' },
      { apiSlug: 'avatar_url', title: 'Avatar', type: 'URL' },
      { apiSlug: 'owner', title: 'Owner', type: 'USER' },
    ],
  },
  {
    apiSlug: 'company',
    singular: 'Company',
    plural: 'Companies',
    icon: 'building',
    attributes: [
      { apiSlug: 'name', title: 'Name', type: 'TEXT', isRequired: true, isIndexed: true },
      { apiSlug: 'domain', title: 'Domain', type: 'TEXT', isUnique: true, isIndexed: true },
      { apiSlug: 'website', title: 'Website', type: 'URL' },
      { apiSlug: 'industry', title: 'Industry', type: 'TEXT' },
      {
        apiSlug: 'size',
        title: 'Size',
        type: 'SELECT',
        config: {
          options: [
            { id: '1-10', label: '1–10' },
            { id: '11-50', label: '11–50' },
            { id: '51-200', label: '51–200' },
            { id: '201-1000', label: '201–1,000' },
            { id: '1000+', label: '1,000+' },
          ],
        },
      },
      { apiSlug: 'location', title: 'Location', type: 'LOCATION' },
      { apiSlug: 'owner', title: 'Owner', type: 'USER' },
    ],
  },
  {
    apiSlug: 'deal',
    singular: 'Deal',
    plural: 'Deals',
    icon: 'handshake',
    attributes: [
      { apiSlug: 'name', title: 'Name', type: 'TEXT', isRequired: true, isIndexed: true },
      {
        apiSlug: 'amount',
        title: 'Amount',
        type: 'CURRENCY',
        config: { currency: 'USD' },
        isIndexed: true,
      },
      {
        apiSlug: 'stage',
        title: 'Stage',
        type: 'STATUS',
        config: { options: DEAL_STAGES.map((s) => ({ ...s })) },
        isIndexed: true,
      },
      { apiSlug: 'close_date', title: 'Close date', type: 'DATE', isIndexed: true },
      {
        apiSlug: 'company',
        title: 'Company',
        type: 'RELATIONSHIP',
        config: { targetObjectTypeId: '$company', multiple: false },
      },
      {
        apiSlug: 'person',
        title: 'Contact',
        type: 'RELATIONSHIP',
        config: { targetObjectTypeId: '$person', multiple: true },
      },
      { apiSlug: 'owner', title: 'Owner', type: 'USER' },
      // Attribution (Phase 8, ADR-019, spec §8.6): stamped once from the originating Keitaro
      // click and immutable thereafter — the sink only ever sets these on a newly created
      // Deal, never on update. Free-form names, since Keitaro campaigns/offers/etc. are
      // per-tracker configuration with no shared vocabulary across customers.
      { apiSlug: 'attribution_campaign', title: 'Campaign', type: 'TEXT', isIndexed: true },
      { apiSlug: 'attribution_source', title: 'Traffic source', type: 'TEXT', isIndexed: true },
      { apiSlug: 'attribution_offer', title: 'Offer', type: 'TEXT' },
      { apiSlug: 'attribution_affiliate_network', title: 'Affiliate network', type: 'TEXT' },
      { apiSlug: 'attribution_creative', title: 'Creative', type: 'TEXT' },
      { apiSlug: 'attribution_landing', title: 'Landing page', type: 'TEXT' },
      { apiSlug: 'attribution_geo', title: 'Geo', type: 'TEXT' },
    ],
  },
];

/**
 * Creates the system object types, their attributes and the default deals pipeline. Idempotent
 * at every level (upsert by the natural unique key): safe to call again on a workspace that was
 * seeded by an earlier version of `SYSTEM_OBJECTS` so a later phase's new system attributes
 * (e.g. Phase 8's Deal attribution fields) reach workspaces seeded before they existed.
 * Pre-existing rows are left untouched — only missing ones are added.
 */
export async function seedSystemObjects(
  db: SystemDb,
  workspaceId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const obj of SYSTEM_OBJECTS) {
    const row = await db.objectType.upsert({
      where: { workspaceId_apiSlug: { workspaceId, apiSlug: obj.apiSlug } },
      update: {},
      create: {
        workspaceId,
        apiSlug: obj.apiSlug,
        singular: obj.singular,
        plural: obj.plural,
        icon: obj.icon,
        isSystem: true,
      },
    });
    ids[obj.apiSlug] = row.id;
  }
  for (const obj of SYSTEM_OBJECTS) {
    const existingCount = await db.attribute.count({
      where: { workspaceId, objectTypeId: ids[obj.apiSlug]! },
    });
    let position = existingCount;
    for (const a of obj.attributes) {
      const config = { ...(a.config ?? {}) };
      if (
        typeof config['targetObjectTypeId'] === 'string' &&
        config['targetObjectTypeId'].startsWith('$')
      ) {
        config['targetObjectTypeId'] = ids[config['targetObjectTypeId'].slice(1)];
      }
      await db.attribute.upsert({
        where: {
          workspaceId_objectTypeId_apiSlug: {
            workspaceId,
            objectTypeId: ids[obj.apiSlug]!,
            apiSlug: a.apiSlug,
          },
        },
        update: {},
        create: {
          workspaceId,
          objectTypeId: ids[obj.apiSlug]!,
          apiSlug: a.apiSlug,
          title: a.title,
          type: a.type,
          config: config as Prisma.InputJsonValue,
          isRequired: a.isRequired ?? false,
          isUnique: a.isUnique ?? false,
          isSystem: true,
          // Indexing is requested here and built by the index.build job after creation.
          isIndexed: a.isIndexed ?? false,
          indexState: a.isIndexed ? 'BUILDING' : 'NONE',
          position: position++,
        },
      });
    }
  }
  const existingPipeline = await db.list.findFirst({
    where: { workspaceId, objectTypeId: ids['deal']!, kind: 'PIPELINE', deletedAt: null },
    select: { id: true },
  });
  const pipeline =
    existingPipeline ??
    (await db.list.create({
      data: {
        workspaceId,
        objectTypeId: ids['deal']!,
        name: 'Sales pipeline',
        kind: 'PIPELINE',
        settings: { stages: DEAL_STAGES.map((s) => s.id) },
      },
    }));
  for (const [i, la] of [
    {
      apiSlug: 'stage',
      title: 'Stage',
      type: 'STATUS' as const,
      config: { options: DEAL_STAGES.map((s) => ({ ...s })) },
    },
    {
      apiSlug: 'probability',
      title: 'Probability %',
      type: 'NUMBER' as const,
      config: { min: 0, max: 100 },
    },
  ].entries()) {
    await db.listAttribute.upsert({
      where: {
        workspaceId_listId_apiSlug: { workspaceId, listId: pipeline.id, apiSlug: la.apiSlug },
      },
      update: {},
      create: {
        workspaceId,
        listId: pipeline.id,
        apiSlug: la.apiSlug,
        title: la.title,
        type: la.type,
        config: la.config,
        position: i,
      },
    });
  }
  return ids;
}
