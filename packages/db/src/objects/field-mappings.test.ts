/**
 * Phase 9 field mapping: create/read a mapping and its rules, replace-all semantics on
 * `setFieldMappingRules`, attribute-existence validation, assigning/unassigning a mapping on a
 * connection, and the raw-payload preview. `getByPath` is covered on its own below since it has
 * no DB dependency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import type { Actor } from '../scoped.ts';
import { persistRawItems } from '../sync/raw-store.ts';
import { createTestDatabase, type TestDatabase } from '../testing/pglite.ts';
import {
  assignFieldMapping,
  createFieldMapping,
  deleteFieldMapping,
  getByPath,
  getFieldMapping,
  listFieldMappings,
  previewFieldMapping,
  setFieldMappingRules,
  updateFieldMapping,
} from './field-mappings.ts';

let db: TestDatabase;
let actor: Actor;
let workspaceId: string;
let emailAttrId: string;
let nameAttrId: string;
let connectionId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const u = await db.prisma.user.create({ data: { email: 'owner@fm.test', name: 'Owner' } });
  const ws = await db.tenancy.createWorkspace({ name: 'FM', slug: 'fm-test', ownerUserId: u.id });
  workspaceId = ws.id;
  actor = { workspaceId, userId: u.id, role: 'OWNER', grants: [] };

  await db.runtime.withTenant(actor, async (t) => {
    const ot = await t.objectType.create({
      data: { workspaceId, apiSlug: 'contact', singular: 'Contact', plural: 'Contacts' },
    });
    const email = await t.attribute.create({
      data: {
        workspaceId,
        objectTypeId: ot.id,
        apiSlug: 'email',
        title: 'Email',
        type: 'EMAIL',
        position: 0,
      },
    });
    emailAttrId = email.id;
    const name = await t.attribute.create({
      data: {
        workspaceId,
        objectTypeId: ot.id,
        apiSlug: 'name',
        title: 'Name',
        type: 'TEXT',
        position: 1,
      },
    });
    nameAttrId = name.id;
    const connection = await t.connection.create({
      data: {
        workspaceId,
        platform: 'INSTAGRAM',
        label: 'IG test',
        accountExternalId: 'acct_1',
        accountName: 'acct_1',
        apiVersion: 'v1',
        tokenRef: 'vault_test',
        ownerUserId: u.id,
      },
    });
    connectionId = connection.id;
  });
});

afterAll(async () => {
  await db?.close();
});

describe('field mapping CRUD + rules', () => {
  it('creates a mapping, sets rules, and reads it back ordered by position', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'INSTAGRAM', name: 'Default IG mapping' }),
    );

    await db.runtime.withTenant(actor, (t) =>
      setFieldMappingRules(t, actor, mappingId, [
        { sourceKind: 'person', sourcePath: 'name', attributeId: nameAttrId, position: 1 },
        { sourceKind: 'person', sourcePath: 'email', attributeId: emailAttrId, position: 0 },
      ]),
    );

    const row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Default IG mapping');
    expect(row!.platform).toBe('INSTAGRAM');
    expect(row!.rules.map((r) => r.attributeId)).toEqual([emailAttrId, nameAttrId]);
    expect(row!.rules.map((r) => r.position)).toEqual([0, 1]);
  });

  it('lists mappings, optionally filtered by platform', async () => {
    await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'YOUTUBE', name: 'YT mapping' }),
    );
    const all = await db.runtime.withTenant(actor, (t) => listFieldMappings(t));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const igOnly = await db.runtime.withTenant(actor, (t) => listFieldMappings(t, 'INSTAGRAM'));
    expect(igOnly.every((m) => m.platform === 'INSTAGRAM')).toBe(true);
    expect(igOnly.some((m) => m.platform === 'YOUTUBE')).toBe(false);
  });

  it('updates name/description', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'TIKTOK', name: 'Original', description: null }),
    );
    await db.runtime.withTenant(actor, (t) =>
      updateFieldMapping(t, mappingId, { name: 'Renamed', description: 'now with notes' }),
    );
    const row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row!.name).toBe('Renamed');
    expect(row!.description).toBe('now with notes');
  });

  it('replace-all semantics: setFieldMappingRules drops the old set entirely', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'LINKEDIN', name: 'Replace test' }),
    );
    await db.runtime.withTenant(actor, (t) =>
      setFieldMappingRules(t, actor, mappingId, [
        { sourceKind: 'person', sourcePath: 'email', attributeId: emailAttrId, position: 0 },
      ]),
    );
    let row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row!.rules.map((r) => r.sourcePath)).toEqual(['email']);

    await db.runtime.withTenant(actor, (t) =>
      setFieldMappingRules(t, actor, mappingId, [
        { sourceKind: 'person', sourcePath: 'name', attributeId: nameAttrId, position: 0 },
      ]),
    );
    row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row!.rules.map((r) => r.sourcePath)).toEqual(['name']);
    expect(row!.rules.map((r) => r.attributeId)).toEqual([nameAttrId]);
  });

  it('rejects a rule set naming an attribute that does not exist in the workspace', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'X', name: 'Bad rule test' }),
    );
    const bogusId = '00000000-0000-0000-0000-000000000000';
    await expect(
      db.runtime.withTenant(actor, (t) =>
        setFieldMappingRules(t, actor, mappingId, [
          { sourceKind: 'person', sourcePath: 'email', attributeId: bogusId, position: 0 },
        ]),
      ),
    ).rejects.toThrow(NexusError);

    const row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row!.rules).toEqual([]);
  });

  it('soft-deletes a mapping so it no longer appears in list/get', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'GMAIL', name: 'Delete me' }),
    );
    await db.runtime.withTenant(actor, (t) => deleteFieldMapping(t, mappingId));
    const row = await db.runtime.withTenant(actor, (t) => getFieldMapping(t, mappingId));
    expect(row).toBeNull();
    const all = await db.runtime.withTenant(actor, (t) => listFieldMappings(t));
    expect(all.some((m) => m.id === mappingId)).toBe(false);
  });
});

describe('assignFieldMapping', () => {
  it('sets and clears Connection.fieldMappingId', async () => {
    const { id: mappingId } = await db.runtime.withTenant(actor, (t) =>
      createFieldMapping(t, actor, { platform: 'INSTAGRAM', name: 'Assignable mapping' }),
    );

    await db.runtime.withTenant(actor, (t) => assignFieldMapping(t, connectionId, mappingId));
    let conn = await db.runtime.withTenant(actor, (t) =>
      t.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(conn.fieldMappingId).toBe(mappingId);

    await db.runtime.withTenant(actor, (t) => assignFieldMapping(t, connectionId, null));
    conn = await db.runtime.withTenant(actor, (t) =>
      t.connection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(conn.fieldMappingId).toBeNull();
  });
});

describe('previewFieldMapping', () => {
  it('extracts each rule sourcePath from the 3 most recent raw payloads, undefined when missing', async () => {
    // One persistRawItems call per item with an explicit, strictly increasing fetchedAt so "3 most
    // recent" has an unambiguous answer (a single batched call would give every item in it the
    // same timestamp).
    const items: { externalId: string; name: string; email?: string }[] = [
      { externalId: 'c1', name: 'Alice', email: 'a@x.test' },
      { externalId: 'c2', name: 'Bob' },
      { externalId: 'c3', name: 'Carol', email: 'c@x.test' },
      { externalId: 'c4', name: 'Dave', email: 'd@x.test' },
    ];
    for (const [i, item] of items.entries()) {
      await db.runtime.withTenant(actor, (t) =>
        persistRawItems(t, {
          workspaceId,
          connectionId,
          platform: 'INSTAGRAM',
          apiVersion: 'v1',
          fetchedAt: new Date(2026, 0, 1, 0, 0, i),
          items: [
            {
              kind: 'ig_comment',
              externalId: item.externalId,
              raw: { user: { name: item.name, ...(item.email ? { email: item.email } : {}) } },
            },
          ],
        }),
      );
    }

    const results = await db.runtime.withTenant(actor, (t) =>
      previewFieldMapping(t, {
        connectionId,
        kind: 'ig_comment',
        rules: [
          { sourceKind: 'person', sourcePath: 'user.name', attributeId: nameAttrId },
          { sourceKind: 'person', sourcePath: 'user.email', attributeId: emailAttrId },
          { sourceKind: 'person', sourcePath: 'user.missing.deep', attributeId: 'no-such-attr' },
        ],
      }),
    );

    // Most recent 3 (fetchedAt desc): Dave, Carol, Bob — Alice (oldest) is excluded.
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.mapped[nameAttrId])).toEqual(['Dave', 'Carol', 'Bob']);
    expect(results.map((r) => r.mapped[emailAttrId])).toEqual(['d@x.test', 'c@x.test', undefined]);
    for (const r of results) {
      expect(r.mapped['no-such-attr']).toBeUndefined();
    }
  });

  it('returns an empty array when there are no matching ExternalObject rows', async () => {
    const results = await db.runtime.withTenant(actor, (t) =>
      previewFieldMapping(t, { connectionId, kind: 'nonexistent_kind', rules: [] }),
    );
    expect(results).toEqual([]);
  });
});

describe('getByPath', () => {
  it('reads a nested object path', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('reads an array index segment', () => {
    expect(getByPath({ a: { b: [1, { c: 2 }] } }, 'a.b.1.c')).toBe(2);
  });

  it('returns undefined for a missing key', () => {
    expect(getByPath({ a: { b: 1 } }, 'a.x.y')).toBeUndefined();
  });

  it('returns undefined when an intermediate value is not an object', () => {
    expect(getByPath({ a: 5 }, 'a.b')).toBeUndefined();
    expect(getByPath({ a: 'str' }, 'a.b')).toBeUndefined();
    expect(getByPath(null, 'a.b')).toBeUndefined();
    expect(getByPath(undefined, 'a.b')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    expect(getByPath({ a: 1 }, '')).toBeUndefined();
  });

  it('reads a single top-level segment', () => {
    expect(getByPath({ a: 1 }, 'a')).toBe(1);
  });
});
