/**
 * Builds the `MatchSubject`s the scorer compares: a Person is its system attributes (name,
 * email, phone, company domain) plus everything its linked identities know; an Identity is its
 * own columns plus the canonical extras kept in `raw._canonical`.
 */
import { subjectBuilder, type MatchSubject } from '@nexus/core';
import type { TenantDb } from '../scoped.ts';
import { loadAttributes } from '../objects/attributes.ts';
import { canonicalOf } from './identities.ts';

export type PersonAttributes = {
  objectTypeId: string;
  companyTypeId: string | null;
  ids: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    avatarUrl: string | null;
    location: string | null;
  };
  companyDomainId: string | null;
  companyNameId: string | null;
};

let cache: WeakMap<object, Promise<PersonAttributes>> | undefined;

/** The Person object's system attribute ids (per workspace; cached per client). */
export async function personAttributes(db: TenantDb): Promise<PersonAttributes> {
  cache ??= new WeakMap();
  let p = cache.get(db);
  if (!p) {
    p = loadPersonAttributes(db);
    cache.set(db, p);
  }
  return p;
}

async function loadPersonAttributes(db: TenantDb): Promise<PersonAttributes> {
  const person = await db.objectType.findFirst({ where: { apiSlug: 'person', deletedAt: null } });
  if (!person) throw new Error('The person object type is missing from this workspace.');
  const attrs = await loadAttributes(db, person.id);
  const by = (slug: string) => attrs.find((a) => a.apiSlug === slug)?.id ?? null;
  const company = await db.objectType.findFirst({ where: { apiSlug: 'company', deletedAt: null } });
  let companyDomainId: string | null = null;
  let companyNameId: string | null = null;
  if (company) {
    const cattrs = await loadAttributes(db, company.id);
    companyDomainId = cattrs.find((a) => a.apiSlug === 'domain')?.id ?? null;
    companyNameId = cattrs.find((a) => a.apiSlug === 'name')?.id ?? null;
  }
  return {
    objectTypeId: person.id,
    companyTypeId: company?.id ?? null,
    ids: {
      name: by('name'),
      email: by('email'),
      phone: by('phone'),
      company: by('company'),
      avatarUrl: by('avatar_url'),
      location: by('location'),
    },
    companyDomainId,
    companyNameId,
  };
}

type IdentityLike = {
  id: string;
  platform: string;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  profileUrl: string | null;
  email: string | null;
  phone: string | null;
  raw: unknown;
};

function feedIdentity(b: ReturnType<typeof subjectBuilder>, i: IdentityLike): void {
  const c = canonicalOf(i.raw);
  b.email(i.email)
    .phone(i.phone)
    .handle(i.platform, i.handle)
    .name(i.displayName)
    .profileUrl(i.profileUrl)
    .bio(c.bio)
    .locale(c.locale)
    .timezone(c.timezone)
    .externalId(i.platform, i.externalId);
  for (const l of c.linked ?? []) b.linked(l.platform, l.externalId);
}

export function identityLabel(
  i: Pick<IdentityLike, 'handle' | 'displayName' | 'externalId'>,
): string {
  return i.displayName ?? (i.handle ? `@${i.handle}` : i.externalId);
}

/** An identity on its own. */
export function identitySubject(i: IdentityLike): MatchSubject {
  const b = subjectBuilder('identity', i.id, identityLabel(i));
  feedIdentity(b, i);
  return b.build();
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A person record with everything its linked identities contribute. */
export async function personSubject(
  db: TenantDb,
  recordId: string,
  opts: { excludeIdentityId?: string } = {},
): Promise<MatchSubject | null> {
  const pa = await personAttributes(db);
  const row = await db.record.findFirst({
    where: { id: recordId, objectTypeId: pa.objectTypeId, deletedAt: null },
    select: { id: true, values: true },
  });
  if (!row) return null;
  const values = row.values as Record<string, unknown>;
  const name = pa.ids.name ? str(values[pa.ids.name]) : null;
  const b = subjectBuilder('record', row.id, name ?? '(unnamed person)');
  b.name(name);
  if (pa.ids.email) b.email(str(values[pa.ids.email]));
  if (pa.ids.phone) b.phone(str(values[pa.ids.phone]));
  if (pa.ids.company && pa.companyDomainId) {
    const rel = values[pa.ids.company];
    const companyIds = Array.isArray(rel)
      ? rel.filter((x): x is string => typeof x === 'string')
      : [];
    if (companyIds.length) {
      const companies = await db.record.findMany({
        where: { id: { in: companyIds }, deletedAt: null },
        select: { values: true },
      });
      for (const c of companies)
        b.domain(str((c.values as Record<string, unknown>)[pa.companyDomainId]));
    }
  }
  const identities = await db.identity.findMany({
    where: { personRecordId: row.id, deletedAt: null },
    select: {
      id: true,
      platform: true,
      externalId: true,
      handle: true,
      displayName: true,
      profileUrl: true,
      email: true,
      phone: true,
      raw: true,
    },
  });
  for (const i of identities) if (i.id !== opts.excludeIdentityId) feedIdentity(b, i);
  return b.build();
}
