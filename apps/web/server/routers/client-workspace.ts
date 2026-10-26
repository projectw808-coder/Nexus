/**
 * The Clients workspace (Pantera CRM's sales screen): every client flattened to the fields the
 * table, KPI cards and detail drawer read, plus the option lists and the agents they can be
 * assigned to. Reads go through the same queryRecords + field-level redaction as record.query;
 * writes stay on record.create / record.update, so the audit trail and automations are shared.
 */
import { countRecords, queryRecords, redactValues, type AttributeRow } from '@nexus/db';
import type { Filter } from '@nexus/core';
import { attributesFor } from '../objects-helpers';
import { authorize, router, tenantProcedure } from '../trpc';

export type ClientOption = { id: string; label: string; category?: string };

export type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
  priority: string | null;
  country: string | null;
  campaign: string | null;
  source: string | null;
  ownerId: string | null;
  nextFollowUp: string | null;
  lastContact: string | null;
  kycStatus: string | null;
  tags: string[];
  experience: string | null;
  goals: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClientAgent = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
};

/** 25 pages of 200: the screen filters and pages in the browser, so it needs the whole book. */
const MAX_PAGES = 25;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function optionsOf(attr: AttributeRow | undefined): ClientOption[] {
  const raw = attr?.config && (attr.config as Record<string, unknown>)['options'];
  if (!Array.isArray(raw)) return [];
  return (raw as ClientOption[]).map((o) => ({
    id: o.id,
    label: o.label,
    ...(o.category ? { category: o.category } : {}),
  }));
}

async function clientType(db: Parameters<typeof attributesFor>[0]) {
  return db.objectType.findFirst({
    where: { apiSlug: 'client', deletedAt: null },
    select: { id: true },
  });
}

function endOfTodayUtc(now = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

export const clientWorkspaceRouter = router({
  all: tenantProcedure.use(authorize('read', 'Record')).query(async ({ ctx }) => {
    const [ot, memberships] = await Promise.all([
      clientType(ctx.db),
      ctx.db.membership.findMany({
        where: { deletedAt: null },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const agents: ClientAgent[] = memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
    }));
    const empty = {
      rows: [] as ClientRow[],
      agents,
      statuses: [] as ClientOption[],
      priorities: [] as ClientOption[],
      kycStatuses: [] as ClientOption[],
      experiences: [] as ClientOption[],
      truncated: false,
      now: Date.now(),
    };
    if (!ot) return empty;

    const attrs = await attributesFor(ctx.db, ot.id);
    const bySlug = new Map(attrs.map((a) => [a.apiSlug, a]));
    const records = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await queryRecords(ctx.db, {
        workspaceId: ctx.workspace.id,
        objectTypeId: ot.id,
        attributes: attrs,
        query: {
          filters: [],
          sort: [],
          limit: 200,
          includeDeleted: false,
          ...(cursor ? { cursor } : {}),
        },
      });
      records.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    const rows: ClientRow[] = records.map((r) => {
      const values = redactValues(ctx.actor, attrs, r.values);
      const get = (slug: string): unknown => {
        const a = bySlug.get(slug);
        return a ? values[a.id] : undefined;
      };
      const owner = get('owner');
      const tags = str(get('tags'));
      return {
        id: r.id,
        name: str(get('name')) ?? '(unnamed)',
        email: str(get('email')),
        phone: str(get('phone')),
        status: str(get('status')),
        priority: str(get('priority')),
        country: str(get('country')),
        campaign: str(get('campaign')),
        source: str(get('source')),
        ownerId: Array.isArray(owner) && typeof owner[0] === 'string' ? owner[0] : null,
        nextFollowUp: str(get('next_follow_up')),
        lastContact: str(get('last_contact')),
        kycStatus: str(get('kyc_status')),
        tags: tags
          ? tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        experience: str(get('experience')),
        goals: str(get('goals')),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      rows,
      agents,
      statuses: optionsOf(bySlug.get('status')),
      priorities: optionsOf(bySlug.get('priority')),
      kycStatuses: optionsOf(bySlug.get('kyc_status')),
      experiences: optionsOf(bySlug.get('experience')),
      truncated,
      now: Date.now(),
    };
  }),

  /** The shell's badges: cheap counts, never the rows. */
  counts: tenantProcedure.use(authorize('read', 'Record')).query(async ({ ctx }) => {
    const unread = await ctx.db.conversation.count({
      where: { deletedAt: null, status: 'OPEN', unreadCount: { gt: 0 } },
    });
    const ot = await clientType(ctx.db);
    if (!ot) return { total: 0, newLeads: 0, followUpsDue: 0, overdue: 0, active: 0, unread };
    const attrs = await attributesFor(ctx.db, ot.id);
    const has = (slug: string) => attrs.some((a) => a.apiSlug === slug);
    const count = (filters: Filter[]) =>
      countRecords(ctx.db, {
        workspaceId: ctx.workspace.id,
        objectTypeId: ot.id,
        attributes: attrs,
        filters,
      });
    const now = new Date().toISOString();
    const [total, newLeads, active, followUpsDue, overdue] = await Promise.all([
      count([]),
      has('status') ? count([{ attribute: 'status', op: 'eq', value: 'new' }]) : 0,
      has('status') ? count([{ attribute: 'status', op: 'eq', value: 'active_client' }]) : 0,
      has('next_follow_up')
        ? count([{ attribute: 'next_follow_up', op: 'lte', value: endOfTodayUtc() }])
        : 0,
      has('next_follow_up') ? count([{ attribute: 'next_follow_up', op: 'lt', value: now }]) : 0,
    ]);
    return { total, newLeads, followUpsDue, overdue, active, unread };
  }),
});
