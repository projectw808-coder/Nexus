/**
 * Candidate generation for the resolver: cheap, index-backed pre-filters that hand at most a
 * few dozen person ids to the scorer. Tier-1 keys (e-mail, phone) and handles come from the
 * Identity table and the Person's system attributes; fuzzy names use pg_trgm `similarity()`
 * on the person's name value with a loose floor — the scorer applies the real 0.85 gate.
 */
import {
  normalizeEmail,
  normalizeHandle,
  normalizeName,
  normalizePhone,
  NAME_SIMILARITY_MIN,
} from '@nexus/core';
import { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';
import { canonicalOf } from './identities.ts';
import { personAttributes } from './subjects.ts';

const CANDIDATE_LIMIT = 25;

type IdentityKeys = {
  id: string;
  platform: string;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  raw: unknown;
};

function phoneSuffix(p: string | null): string | null {
  const n = normalizePhone(p);
  if (!n) return null;
  const d = n.replace(/^\+/, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

/** Person record ids worth scoring against an identity. */
export async function candidatePersonsForIdentity(
  db: TenantDb,
  workspaceId: string,
  identity: IdentityKeys,
): Promise<string[]> {
  const pa = await personAttributes(db);
  const out = new Set<string>();
  const email = normalizeEmail(identity.email);
  const phone = phoneSuffix(identity.phone);
  const handle = normalizeHandle(identity.handle);
  const name = normalizeName(identity.displayName);
  const linked = canonicalOf(identity.raw).linked ?? [];

  // Through other identities that already belong to a person.
  const viaIdentities = await db.identity.findMany({
    where: {
      id: { not: identity.id },
      personRecordId: { not: null },
      deletedAt: null,
      OR: [
        ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        ...(phone ? [{ phone: { endsWith: phone } }] : []),
        ...(handle ? [{ handle: { equals: handle, mode: 'insensitive' as const } }] : []),
        ...linked.map((l) => ({ platform: l.platform, externalId: l.externalId })),
        // Someone else's identity that lists us as linked.
        {
          raw: {
            path: ['_canonical', 'linked'],
            array_contains: [{ platform: identity.platform, externalId: identity.externalId }],
          },
        },
      ],
    },
    select: { personRecordId: true },
    take: CANDIDATE_LIMIT,
  });
  for (const i of viaIdentities) if (i.personRecordId) out.add(i.personRecordId);

  // Through the person's own system attributes.
  const clauses: Prisma.Sql[] = [];
  if (email && pa.ids.email)
    clauses.push(Prisma.sql`lower(r."values" ->> ${pa.ids.email}) = ${email}`);
  if (phone && pa.ids.phone)
    clauses.push(
      Prisma.sql`right(regexp_replace(coalesce(r."values" ->> ${pa.ids.phone}, ''), '\\D', '', 'g'), 9) = ${phone}`,
    );
  if (name && pa.ids.name)
    clauses.push(
      Prisma.sql`similarity(lower(coalesce(r."values" ->> ${pa.ids.name}, '')), ${name}) >= ${NAME_SIMILARITY_MIN - 0.25}`,
    );
  if (clauses.length) {
    const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r."id" FROM "Record" r
      WHERE r."workspaceId" = ${workspaceId} AND r."objectTypeId" = ${pa.objectTypeId}
        AND r."deletedAt" IS NULL AND r."mergeState" = 'ACTIVE'
        AND (${Prisma.join(clauses, ' OR ')})
      LIMIT ${CANDIDATE_LIMIT}`);
    for (const r of rows) out.add(r.id);
  }
  return [...out];
}

/** Other active person ids worth scoring against a person (nightly duplicate scan, re-scoring). */
export async function candidatePersonsForPerson(
  db: TenantDb,
  workspaceId: string,
  recordId: string,
): Promise<string[]> {
  const pa = await personAttributes(db);
  const row = await db.record.findFirst({
    where: { id: recordId, deletedAt: null, mergeState: 'ACTIVE' },
    select: { values: true },
  });
  if (!row) return [];
  const values = row.values as Record<string, unknown>;
  const str = (id: string | null) => (id && typeof values[id] === 'string' ? values[id] : null);
  const email = normalizeEmail(str(pa.ids.email));
  const phone = phoneSuffix(str(pa.ids.phone));
  const name = normalizeName(str(pa.ids.name));
  const out = new Set<string>();

  const mine = await db.identity.findMany({
    where: { personRecordId: recordId, deletedAt: null },
    select: { email: true, phone: true, handle: true },
  });
  const emails = new Set(
    [email, ...mine.map((i) => normalizeEmail(i.email))].filter(Boolean) as string[],
  );
  const phones = new Set(
    [phone, ...mine.map((i) => phoneSuffix(i.phone))].filter(Boolean) as string[],
  );
  const handles = new Set(mine.map((i) => normalizeHandle(i.handle)).filter(Boolean) as string[]);

  if (emails.size || phones.size || handles.size) {
    const via = await db.identity.findMany({
      where: {
        personRecordId: { not: null, notIn: [recordId] },
        deletedAt: null,
        OR: [
          ...[...emails].map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })),
          ...[...phones].map((p) => ({ phone: { endsWith: p } })),
          ...[...handles].map((h) => ({ handle: { equals: h, mode: 'insensitive' as const } })),
        ],
      },
      select: { personRecordId: true },
      take: CANDIDATE_LIMIT,
    });
    for (const i of via) if (i.personRecordId) out.add(i.personRecordId);
  }

  const clauses: Prisma.Sql[] = [];
  if (pa.ids.email && emails.size)
    clauses.push(Prisma.sql`lower(r."values" ->> ${pa.ids.email}) = ANY(${[...emails]}::text[])`);
  if (pa.ids.phone && phones.size)
    clauses.push(
      Prisma.sql`right(regexp_replace(coalesce(r."values" ->> ${pa.ids.phone}, ''), '\\D', '', 'g'), 9) = ANY(${[...phones]}::text[])`,
    );
  if (pa.ids.name && name)
    clauses.push(
      Prisma.sql`similarity(lower(coalesce(r."values" ->> ${pa.ids.name}, '')), ${name}) >= ${NAME_SIMILARITY_MIN - 0.25}`,
    );
  if (clauses.length) {
    const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r."id" FROM "Record" r
      WHERE r."workspaceId" = ${workspaceId} AND r."objectTypeId" = ${pa.objectTypeId}
        AND r."id" <> ${recordId} AND r."deletedAt" IS NULL AND r."mergeState" = 'ACTIVE'
        AND (${Prisma.join(clauses, ' OR ')})
      LIMIT ${CANDIDATE_LIMIT}`);
    for (const r of rows) out.add(r.id);
  }
  out.delete(recordId);
  return [...out];
}
