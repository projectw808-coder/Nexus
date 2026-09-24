/**
 * Generated-column indexing for hot attributes (§6.2 hybrid storage rule, §6.6 migration
 * strategy, ADR-009). Flipping `isIndexed` never rewrites the table synchronously:
 *
 *   a. add a nullable plain column `gen_<attributeId>` of the type's SQL family;
 *   b. install a trigger that keeps it current, then backfill in batches (progress on the row);
 *   c. build the btree (`CONCURRENTLY` on Postgres);
 *   d. mark the attribute READY — from then on the query builder uses the column.
 *
 * Dropping is the mirror image, 24h after the attribute is soft-deleted (`purgeAfter`).
 * Column, index, trigger and function names follow the patterns in drift-allowlist.json.
 */
import { indexColumnKind } from '@nexus/core';
import { Prisma } from '../generated/prisma/client.ts';
import { createDdlRunner } from '../ddl.ts';
import type { TenantRuntime } from '../scoped.ts';
import { genColumn } from './records.ts';

const BATCH = 5_000;

export type IndexBuildProgress = { attributeId: string; done: number; total: number };

function names(attributeId: string) {
  const col = genColumn(attributeId);
  const hex = col.slice(4);
  return {
    column: `"${col}"`,
    index: `record_gen_${hex}_idx`,
    fn: `nexus_gen_${hex}_sync`,
    trigger: `record_gen_${hex}_sync`,
  };
}

function sqlType(kind: NonNullable<ReturnType<typeof indexColumnKind>>): string {
  return kind === 'numeric'
    ? 'numeric'
    : kind === 'timestamptz'
      ? 'timestamptz'
      : kind === 'boolean'
        ? 'boolean'
        : 'text';
}

function extractExpr(
  kind: NonNullable<ReturnType<typeof indexColumnKind>>,
  source: string,
): string {
  switch (kind) {
    case 'numeric':
      return `nexus_immutable_numeric(${source})`;
    case 'timestamptz':
      return `nexus_immutable_timestamptz(${source})`;
    case 'boolean':
      return `nexus_immutable_boolean(${source})`;
    default:
      return source;
  }
}

/**
 * Build the column, trigger and index for one attribute. Safe to re-run (idempotent DDL, resumes
 * the backfill). Reports progress through `onProgress` and on `Attribute.indexProgress`.
 */
export async function runIndexBuild(
  runtime: TenantRuntime,
  attributeId: string,
  onProgress?: (p: IndexBuildProgress) => void,
): Promise<void> {
  const attr = await runtime.withSystem((s) =>
    s.attribute.findUnique({
      where: { id: attributeId },
      select: { id: true, type: true, objectTypeId: true, workspaceId: true, deletedAt: true },
    }),
  );
  if (!attr) throw new Error(`attribute ${attributeId} not found`);
  const kind = indexColumnKind(attr.type);
  if (!kind) throw new Error(`attribute type ${attr.type} cannot be indexed`);
  if (attr.deletedAt) throw new Error(`attribute ${attributeId} is deleted`);

  const n = names(attributeId);
  const ddl = await createDdlRunner();
  try {
    await runtime.withSystem((s) =>
      s.attribute.update({
        where: { id: attributeId },
        data: { indexState: 'BUILDING', indexProgress: 0, indexError: null },
      }),
    );
    const extract = extractExpr(kind, `(NEW."values" ->> '${attributeId}')`);
    await ddl.exec(`ALTER TABLE "Record" ADD COLUMN IF NOT EXISTS ${n.column} ${sqlType(kind)};`);
    await ddl.exec(`
      CREATE OR REPLACE FUNCTION ${n.fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."objectTypeId" = '${attr.objectTypeId}' THEN
          NEW.${n.column} := ${extract};
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS ${n.trigger} ON "Record";
      CREATE TRIGGER ${n.trigger} BEFORE INSERT OR UPDATE OF "values" ON "Record"
        FOR EACH ROW EXECUTE FUNCTION ${n.fn}();
    `);

    // b. backfill in batches, each its own transaction, progress persisted.
    const total = await runtime.withSystem((s) =>
      s.record.count({ where: { objectTypeId: attr.objectTypeId } }),
    );
    let done = 0;
    for (;;) {
      const updated = await runtime.withSystem((s) =>
        s.$executeRaw(Prisma.sql`
          WITH batch AS (
            SELECT "id" FROM "Record"
            WHERE "objectTypeId" = ${attr.objectTypeId}
              AND ${Prisma.raw(n.column)} IS NULL
              AND ("values" ? ${attributeId})
            LIMIT ${BATCH}
          )
          UPDATE "Record" r SET ${Prisma.raw(n.column)} = ${Prisma.raw(extractExpr(kind, `(r."values" ->> '${attributeId}')`))}
          FROM batch WHERE r."id" = batch."id"`),
      );
      done += updated;
      const pct = total === 0 ? 100 : Math.min(99, Math.round((done / total) * 100));
      await runtime.withSystem((s) =>
        s.attribute.update({ where: { id: attributeId }, data: { indexProgress: pct } }),
      );
      onProgress?.({ attributeId, done, total });
      if (updated === 0) break;
    }

    // c. the btree, composite so filter+sort within one object type is index-only ordered.
    await ddl.createIndex(n.index, '"Record"', `("workspaceId", "objectTypeId", ${n.column})`);

    // d. swap in.
    await runtime.withSystem((s) =>
      s.attribute.update({
        where: { id: attributeId },
        data: { indexState: 'READY', isIndexed: true, indexProgress: 100 },
      }),
    );
  } catch (e) {
    await runtime.withSystem((s) =>
      s.attribute.update({
        where: { id: attributeId },
        data: {
          indexState: 'FAILED',
          indexError: e instanceof Error ? e.message.slice(0, 500) : String(e),
        },
      }),
    );
    throw e;
  } finally {
    await ddl.close();
  }
}

/** Drop the trigger, index and column of an attribute (after soft-delete + retention). */
export async function dropIndexArtifacts(
  runtime: TenantRuntime,
  attributeId: string,
): Promise<void> {
  const n = names(attributeId);
  const ddl = await createDdlRunner();
  try {
    await ddl.exec(`
      DROP TRIGGER IF EXISTS ${n.trigger} ON "Record";
      DROP FUNCTION IF EXISTS ${n.fn}();
      DROP INDEX IF EXISTS ${n.index};
      ALTER TABLE "Record" DROP COLUMN IF EXISTS ${n.column};
    `);
  } finally {
    await ddl.close();
  }
  await runtime.withSystem((s) =>
    s.attribute.updateMany({
      where: { id: attributeId },
      data: { indexState: 'NONE', isIndexed: false, indexProgress: 0 },
    }),
  );
}

/** Attributes whose 24h retention has passed: drop their column artifacts. Returns purged ids. */
export async function purgeDeletedAttributes(
  runtime: TenantRuntime,
  now = new Date(),
): Promise<string[]> {
  const due = await runtime.withSystem((s) =>
    s.attribute.findMany({
      where: { deletedAt: { not: null }, purgeAfter: { lte: now }, indexState: { not: 'NONE' } },
      select: { id: true },
    }),
  );
  for (const a of due) await dropIndexArtifacts(runtime, a.id);
  await runtime.withSystem((s) =>
    s.attribute.updateMany({
      where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
      data: { purgeAfter: null },
    }),
  );
  return due.map((a) => a.id);
}

/** Attributes left BUILDING (worker restart) or requested at seed time: what the job runner should pick up. */
export async function pendingIndexBuilds(runtime: TenantRuntime): Promise<string[]> {
  const rows = await runtime.withSystem((s) =>
    s.attribute.findMany({
      where: { deletedAt: null, isIndexed: true, indexState: { in: ['BUILDING', 'NONE'] } },
      select: { id: true },
    }),
  );
  return rows.map((r) => r.id);
}
