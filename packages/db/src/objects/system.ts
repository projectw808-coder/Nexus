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

/** Client pipeline stages — mirrors DEAL_STAGES' {id, label, category} shape so the board view,
 * filters and the STATUS attribute type all work identically to Deal.stage. */
export const CLIENT_STATUSES = [
  { id: 'new', label: 'New', category: 'open' },
  { id: 'contacted', label: 'Contacted', category: 'open' },
  { id: 'interested', label: 'Interested', category: 'open' },
  { id: 'callback', label: 'Callback', category: 'open' },
  { id: 'no_answer', label: 'No Answer', category: 'open' },
  { id: 'kyc_pending', label: 'KYC Pending', category: 'open' },
  { id: 'kyc_completed', label: 'KYC Completed', category: 'open' },
  { id: 'active_client', label: 'Active Client', category: 'won' },
  { id: 'not_interested', label: 'Not Interested', category: 'lost' },
  { id: 'invalid_lead', label: 'Invalid Lead', category: 'lost' },
] as const;

/** Earlier client statuses, retired from workspaces that never used them (see reconcile). */
const RETIRED_CLIENT_STATUS_IDS = new Set(['qualified', 'won', 'lost']);

export const CLIENT_PRIORITIES = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
] as const;

export const KYC_STATUSES = [
  { id: 'not_started', label: 'Not started' },
  { id: 'pending', label: 'Pending' },
  { id: 'completed', label: 'Completed' },
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
  {
    apiSlug: 'client',
    singular: 'Client',
    plural: 'Clients',
    icon: 'users',
    attributes: [
      { apiSlug: 'name', title: 'Name', type: 'TEXT', isRequired: true, isIndexed: true },
      { apiSlug: 'email', title: 'Email', type: 'EMAIL', isIndexed: true },
      { apiSlug: 'phone', title: 'Phone', type: 'PHONE' },
      {
        apiSlug: 'status',
        title: 'Status',
        type: 'STATUS',
        config: { options: CLIENT_STATUSES.map((s) => ({ ...s })) },
        isIndexed: true,
      },
      // Same free-form convention as Deal's attribution_campaign/attribution_source (Phase 8):
      // per-tracker/per-channel naming has no shared vocabulary across customers, so these stay
      // TEXT rather than a fixed SELECT list.
      { apiSlug: 'campaign', title: 'Campaign', type: 'TEXT', isIndexed: true },
      { apiSlug: 'source', title: 'Source', type: 'TEXT', isIndexed: true },
      // Captured from panteraai.co.uk's early-access form (REST v1) — option ids match that
      // form's <select> values exactly, so no mapping layer sits between the two.
      {
        apiSlug: 'experience',
        title: 'Trading experience',
        type: 'SELECT',
        config: {
          options: [
            { id: 'new', label: 'New to trading' },
            { id: 'intermediate', label: '1–3 years' },
            { id: 'experienced', label: '3+ years' },
            { id: 'professional', label: 'Professional / institutional' },
          ],
        },
        isIndexed: true,
      },
      { apiSlug: 'goals', title: 'Goals', type: 'TEXT' },
      {
        apiSlug: 'priority',
        title: 'Priority',
        type: 'SELECT',
        config: { options: CLIENT_PRIORITIES.map((p) => ({ ...p })) },
        isIndexed: true,
      },
      // ISO 3166-1 alpha-2 (e.g. "GB"); the Clients view falls back to the phone's dial code.
      { apiSlug: 'country', title: 'Country', type: 'TEXT', isIndexed: true },
      { apiSlug: 'next_follow_up', title: 'Next follow-up', type: 'DATETIME', isIndexed: true },
      { apiSlug: 'last_contact', title: 'Last contact', type: 'DATETIME', isIndexed: true },
      {
        apiSlug: 'kyc_status',
        title: 'KYC status',
        type: 'SELECT',
        config: { options: KYC_STATUSES.map((k) => ({ ...k })) },
      },
      // Free-form, comma-separated: a SELECT would need an admin to add every new tag first.
      { apiSlug: 'tags', title: 'Tags', type: 'TEXT' },
      {
        apiSlug: 'company',
        title: 'Company',
        type: 'RELATIONSHIP',
        config: { targetObjectTypeId: '$company', multiple: false },
      },
      { apiSlug: 'owner', title: 'Owner', type: 'USER' },
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

  const existingClientPipeline = await db.list.findFirst({
    where: { workspaceId, objectTypeId: ids['client']!, kind: 'PIPELINE', deletedAt: null },
    select: { id: true },
  });
  const clientPipeline =
    existingClientPipeline ??
    (await db.list.create({
      data: {
        workspaceId,
        objectTypeId: ids['client']!,
        name: 'Client pipeline',
        kind: 'PIPELINE',
        settings: { stages: CLIENT_STATUSES.map((s) => s.id) },
      },
    }));
  await db.listAttribute.upsert({
    where: {
      workspaceId_listId_apiSlug: { workspaceId, listId: clientPipeline.id, apiSlug: 'status' },
    },
    update: {},
    create: {
      workspaceId,
      listId: clientPipeline.id,
      apiSlug: 'status',
      title: 'Status',
      type: 'STATUS',
      config: { options: CLIENT_STATUSES.map((s) => ({ ...s })) },
      position: 0,
    },
  });

  await reconcileClientStatuses(db, workspaceId, ids['client']!, clientPipeline.id);

  return ids;
}

type StatusOption = { id: string; label: string; category?: string };

/** Keeps the existing order (a workspace may have reordered), drops `drop`, appends what's new. */
function reconcileOptions(existing: unknown, drop: ReadonlySet<string>): StatusOption[] | null {
  const current = Array.isArray(existing) ? (existing as StatusOption[]) : [];
  const kept = current.filter((o) => !drop.has(o.id));
  const have = new Set(kept.map((o) => o.id));
  const added = CLIENT_STATUSES.filter((s) => !have.has(s.id)).map((s) => ({ ...s }));
  if (!added.length && kept.length === current.length) return null;
  return [...kept, ...added];
}

const optionsOf = (config: unknown): unknown =>
  config && typeof config === 'object' ? (config as Record<string, unknown>)['options'] : undefined;

/**
 * The seed's upserts never touch an existing row, so a workspace seeded with the first client
 * statuses would keep them forever. Append the current ones, and retire the earlier ones only
 * where no record or board entry still uses them — a status in use is never pulled out from under
 * its records. Cheap on the common path: one read, no writes once a workspace is up to date.
 */
async function reconcileClientStatuses(
  db: SystemDb,
  workspaceId: string,
  clientTypeId: string,
  pipelineId: string,
): Promise<void> {
  const attr = await db.attribute.findFirst({
    where: { workspaceId, objectTypeId: clientTypeId, apiSlug: 'status', deletedAt: null },
    select: { id: true, config: true },
  });
  const pipeline = await db.list.findFirst({
    where: { id: pipelineId },
    select: { settings: true },
  });
  const listAttr = await db.listAttribute.findFirst({
    where: { workspaceId, listId: pipelineId, apiSlug: 'status' },
    select: { id: true, config: true },
  });

  const present = new Set<string>();
  for (const o of [optionsOf(attr?.config), optionsOf(listAttr?.config)]) {
    if (Array.isArray(o)) for (const opt of o as StatusOption[]) present.add(opt.id);
  }
  const settings = (pipeline?.settings ?? {}) as Record<string, unknown>;
  const stages = Array.isArray(settings['stages']) ? (settings['stages'] as string[]) : [];
  for (const s of stages) present.add(s);

  const drop = new Set<string>();
  for (const id of RETIRED_CLIENT_STATUS_IDS) {
    if (!present.has(id)) continue;
    const [records, entries] = await Promise.all([
      attr
        ? db.record.count({
            where: {
              workspaceId,
              objectTypeId: clientTypeId,
              deletedAt: null,
              values: { path: [attr.id], equals: id },
            },
          })
        : 0,
      db.listEntry.count({ where: { listId: pipelineId, stage: id, deletedAt: null } }),
    ]);
    if (records === 0 && entries === 0) drop.add(id);
  }

  if (attr) {
    const next = reconcileOptions(optionsOf(attr.config), drop);
    if (next)
      await db.attribute.update({
        where: { id: attr.id },
        data: {
          config: {
            ...(attr.config as Record<string, unknown>),
            options: next,
          } as Prisma.InputJsonValue,
        },
      });
  }
  if (listAttr) {
    const next = reconcileOptions(optionsOf(listAttr.config), drop);
    if (next)
      await db.listAttribute.update({
        where: { id: listAttr.id },
        data: {
          config: {
            ...(listAttr.config as Record<string, unknown>),
            options: next,
          } as Prisma.InputJsonValue,
        },
      });
  }
  const keptStages = stages.filter((s) => !drop.has(s));
  const addedStages = CLIENT_STATUSES.map((s) => s.id).filter((s) => !keptStages.includes(s));
  if (addedStages.length || keptStages.length !== stages.length)
    await db.list.update({
      where: { id: pipelineId },
      data: {
        settings: { ...settings, stages: [...keptStages, ...addedStages] } as Prisma.InputJsonValue,
      },
    });
}
