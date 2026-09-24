/**
 * CSV import (§16 Phase 2): mapping → dry-run preview → run → rollback. The ImportJob row holds
 * the source, so every step works from the same data, and records created by a run carry the
 * job id so a rollback removes exactly those and nothing else.
 */
import {
  NexusError,
  coerceCell,
  parseCsv,
  validateRecordValues,
  type AttributeDef,
} from '@nexus/core';
import type { Prisma } from '../generated/prisma/client.ts';
import type { Actor, TenantDb, TenantRuntime } from '../scoped.ts';
import { loadAttributes, toDef, writableAttributes, type AttributeRow } from './attributes.ts';
import { createRecord, updateRecord, queryRecords } from './records.ts';

export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 50_000;
const CHUNK = 500;

export type ColumnMapping = Record<string, { attributeId: string } | { skip: true }>;
export type ImportOptions = { dedupeAttributeId?: string | null; updateExisting?: boolean };
export type RowError = { row: number; column: string | null; message: string };
export type ImportStats = {
  total: number;
  valid: number;
  invalid: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

/** Propose a mapping: header → attribute by slug, title or a normalised form of either. */
export function suggestMapping(headers: string[], attrs: AttributeDef[]): ColumnMapping {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const h of headers) {
    const key = norm(h);
    const match = attrs.find(
      (a) => !used.has(a.id) && (norm(a.apiSlug) === key || norm(a.title) === key),
    );
    if (match) {
      mapping[h] = { attributeId: match.id };
      used.add(match.id);
    } else {
      mapping[h] = { skip: true };
    }
  }
  return mapping;
}

function rowToValues(
  headers: string[],
  row: string[],
  mapping: ColumnMapping,
  attrsById: Map<string, AttributeDef>,
  rowNumber: number,
  errors: RowError[],
): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  let bad = false;
  headers.forEach((h, i) => {
    const m = mapping[h];
    if (!m || 'skip' in m) return;
    const attr = attrsById.get(m.attributeId);
    if (!attr) {
      errors.push({ row: rowNumber, column: h, message: 'mapped to an unknown attribute' });
      bad = true;
      return;
    }
    const r = coerceCell(attr, row[i] ?? '');
    if ('error' in r) {
      errors.push({ row: rowNumber, column: h, message: r.error });
      bad = true;
    } else if ('value' in r) {
      values[attr.id] = r.value;
    }
  });
  return bad ? null : values;
}

export type Preview = {
  headers: string[];
  sample: string[][];
  mapping: ColumnMapping;
  stats: Pick<ImportStats, 'total' | 'valid' | 'invalid'>;
  errors: RowError[];
  unmappedHeaders: string[];
};

/** Dry run: parse, map, validate every row. Nothing is written. */
export function previewImport(
  sourceText: string,
  delimiter: string,
  attrs: AttributeDef[],
  mapping?: ColumnMapping,
): Preview {
  const table = parseCsv(sourceText, delimiter);
  if (table.rows.length > IMPORT_MAX_ROWS) {
    throw new NexusError('VALIDATION', {
      context: {
        reason: `Imports are limited to ${IMPORT_MAX_ROWS.toLocaleString()} rows per file.`,
      },
    });
  }
  const effective = mapping ?? suggestMapping(table.headers, attrs);
  const attrsById = new Map(attrs.map((a) => [a.id, a]));
  const errors: RowError[] = [];
  let valid = 0;
  table.rows.forEach((row, i) => {
    const rowNumber = i + 2; // 1-based, after the header
    const values = rowToValues(table.headers, row, effective, attrsById, rowNumber, errors);
    if (!values) return;
    const v = validateRecordValues(attrs, values, 'create');
    if (v.ok) valid += 1;
    else {
      for (const f of (v.error.details['fields'] as { apiSlug: string; message: string }[]) ?? []) {
        errors.push({ row: rowNumber, column: f.apiSlug, message: f.message });
      }
    }
  });
  return {
    headers: table.headers,
    sample: table.rows.slice(0, 10),
    mapping: effective,
    stats: { total: table.rows.length, valid, invalid: table.rows.length - valid },
    errors: errors.slice(0, 100),
    unmappedHeaders: table.headers.filter((h) => {
      const m = effective[h];
      return !m || 'skip' in m;
    }),
  };
}

/**
 * Execute an import in chunks. Each chunk is its own tenant transaction so progress survives a
 * crash and a restart resumes from `progress`. Invalid rows are skipped and reported; a chunk
 * failure marks the job FAILED (created rows stay, tagged with the job, so rollback still works).
 */
export async function runImport(
  runtime: TenantRuntime,
  actor: Actor,
  jobId: string,
): Promise<ImportStats> {
  const job = await runtime.withTenant(actor, (db) =>
    db.importJob.findFirst({ where: { id: jobId, deletedAt: null } }),
  );
  if (!job) throw new NexusError('NOT_FOUND');
  if (job.status !== 'PREVIEW' && job.status !== 'FAILED') {
    throw new NexusError('CONFLICT', {
      context: { reason: `This import is ${job.status.toLowerCase()}.` },
    });
  }
  const attrs = await runtime.withTenant(actor, (db) => loadAttributes(db, job.objectTypeId));
  const writable = writableAttributes(actor, attrs);
  const defs = writable.map(toDef);
  const attrsById = new Map(defs.map((a) => [a.id, a]));
  const mapping = job.mapping as ColumnMapping;
  const options = (job.options ?? {}) as ImportOptions;
  const table = parseCsv(job.sourceText, job.delimiter);
  const stats: ImportStats = {
    ...(job.stats as Partial<ImportStats>),
    total: table.rows.length,
    valid: 0,
    invalid: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  const errors: RowError[] = [];
  const startRow = job.status === 'FAILED' ? job.progress : 0;

  await runtime.withTenant(actor, (db) =>
    db.importJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date(), error: null },
    }),
  );

  try {
    for (let start = startRow; start < table.rows.length; start += CHUNK) {
      const chunk = table.rows.slice(start, start + CHUNK);
      await runtime.withTenant(actor, async (db) => {
        for (let i = 0; i < chunk.length; i++) {
          const rowNumber = start + i + 2;
          const values = rowToValues(
            table.headers,
            chunk[i]!,
            mapping,
            attrsById,
            rowNumber,
            errors,
          );
          if (!values) {
            stats.failed += 1;
            continue;
          }
          try {
            const existing = options.dedupeAttributeId
              ? await findByAttribute(
                  db,
                  actor,
                  job.objectTypeId,
                  attrs,
                  options.dedupeAttributeId,
                  values[options.dedupeAttributeId],
                )
              : null;
            if (existing) {
              if (options.updateExisting) {
                await updateRecord(db, actor, {
                  recordId: existing,
                  attributes: attrs,
                  input: values,
                });
                stats.updated += 1;
              } else {
                stats.skipped += 1;
              }
            } else {
              await createRecord(db, actor, {
                objectTypeId: job.objectTypeId,
                attributes: attrs,
                input: values,
                importJobId: jobId,
              });
              stats.created += 1;
            }
          } catch (e) {
            stats.failed += 1;
            errors.push({
              row: rowNumber,
              column: null,
              message: NexusError.is(e)
                ? e.userMessage
                : e instanceof Error
                  ? e.message
                  : String(e),
            });
          }
        }
        await db.importJob.update({
          where: { id: jobId },
          data: {
            progress: Math.min(start + chunk.length, table.rows.length),
            stats: stats as unknown as Prisma.InputJsonValue,
            errors: errors.slice(0, 200) as unknown as Prisma.InputJsonValue,
          },
        });
      });
    }
    await runtime.withTenant(actor, (db) =>
      db.importJob.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', finishedAt: new Date(), progress: table.rows.length },
      }),
    );
  } catch (e) {
    await runtime.withTenant(actor, (db) =>
      db.importJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 500) : String(e) },
      }),
    );
    throw e;
  }
  return stats;
}

async function findByAttribute(
  db: TenantDb,
  actor: Actor,
  objectTypeId: string,
  attrs: AttributeRow[],
  attributeId: string,
  value: unknown,
): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  const r = await queryRecords(db, {
    workspaceId: actor.workspaceId,
    objectTypeId,
    attributes: attrs,
    query: {
      filters: [{ attribute: attributeId, op: 'eq', value }],
      sort: [],
      limit: 1,
      includeDeleted: false,
    },
  });
  return r.items[0]?.id ?? null;
}

/** Soft-delete every record the run created (and their list entries); updates are not reverted. */
export async function rollbackImport(db: TenantDb, jobId: string): Promise<{ removed: number }> {
  const job = await db.importJob.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) throw new NexusError('NOT_FOUND');
  if (job.status !== 'COMPLETED' && job.status !== 'FAILED') {
    throw new NexusError('CONFLICT', {
      context: {
        reason: `Only a completed or failed import can be rolled back (this one is ${job.status.toLowerCase()}).`,
      },
    });
  }
  const now = new Date();
  const records = await db.record.findMany({
    where: { importJobId: jobId, deletedAt: null },
    select: { id: true },
  });
  const ids = records.map((r) => r.id);
  if (ids.length > 0) {
    await db.record.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now } });
    await db.listEntry.updateMany({
      where: { recordId: { in: ids }, deletedAt: null },
      data: { deletedAt: now },
    });
    await db.recordRelation.updateMany({
      where: { OR: [{ fromRecordId: { in: ids } }, { toRecordId: { in: ids } }], deletedAt: null },
      data: { deletedAt: now },
    });
  }
  await db.importJob.update({
    where: { id: jobId },
    data: { status: 'ROLLED_BACK', rolledBackAt: now },
  });
  return { removed: ids.length };
}
