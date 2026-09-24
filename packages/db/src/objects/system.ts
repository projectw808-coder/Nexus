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
    ],
  },
];

/** Creates the system object types, their attributes and the default deals pipeline. */
export async function seedSystemObjects(
  db: SystemDb,
  workspaceId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const obj of SYSTEM_OBJECTS) {
    const row = await db.objectType.create({
      data: {
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
    let position = 0;
    for (const a of obj.attributes) {
      const config = { ...(a.config ?? {}) };
      if (
        typeof config['targetObjectTypeId'] === 'string' &&
        config['targetObjectTypeId'].startsWith('$')
      ) {
        config['targetObjectTypeId'] = ids[config['targetObjectTypeId'].slice(1)];
      }
      await db.attribute.create({
        data: {
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
  const pipeline = await db.list.create({
    data: {
      workspaceId,
      objectTypeId: ids['deal']!,
      name: 'Sales pipeline',
      kind: 'PIPELINE',
      settings: { stages: DEAL_STAGES.map((s) => s.id) },
    },
  });
  await db.listAttribute.create({
    data: {
      workspaceId,
      listId: pipeline.id,
      apiSlug: 'stage',
      title: 'Stage',
      type: 'STATUS',
      config: { options: DEAL_STAGES.map((s) => ({ ...s })) },
      position: 0,
    },
  });
  await db.listAttribute.create({
    data: {
      workspaceId,
      listId: pipeline.id,
      apiSlug: 'probability',
      title: 'Probability %',
      type: 'NUMBER',
      config: { min: 0, max: 100 },
      position: 1,
    },
  });
  return ids;
}
