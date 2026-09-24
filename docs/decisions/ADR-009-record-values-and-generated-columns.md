# ADR-009 — Record values are keyed by attribute id; hot attributes get a trigger-maintained column

**Status:** accepted (Phase 2) · **Spec:** §6.2 hybrid storage rule, §6.6 generated-column strategy

## Context

`Record.values` is JSONB. Two choices shape everything above it: the key (slug or id) and how a
hot attribute gets a btree. Stored generated columns need `IMMUTABLE` expressions and rewrite the
table under `ACCESS EXCLUSIVE` when added.

## Decision

- **Keys are attribute ids.** Renaming a slug touches one row, never a million; field mappings
  and saved views reference ids too. The API accepts slugs or ids on input and reports slugs.
  `_unmapped` is the one reserved key (§6.6 canonical → graph mapping).
- **A plain column plus a trigger, not a stored generated column.** `attribute.setIndexed`
  only marks the row BUILDING and dispatches `index.build`. The job adds a nullable column
  `gen_<id>`, installs `record_gen_<id>_sync` (fires only for that object type), backfills in
  5,000-row batches with progress on the attribute, builds `record_gen_<id>_idx` on
  `("workspaceId","objectTypeId",gen_<id>)` — `CONCURRENTLY` on Postgres — and marks READY. The
  query builder reads the column once READY and the JSONB expression otherwise, so a build in
  progress never changes results. Dropping is the mirror image 24h after soft-delete.
- Indexable types are the §6.6 whitelist (text-like, numeric, boolean, date-time); the
  extraction wrappers `nexus_immutable_*` return NULL on unparsable input.
- DDL runs as the table owner (`DATABASE_ADMIN_URL`, or `RESET ROLE` on PGlite); the app role
  never alters tables.

## Consequences

The drift gate allowlists `gen_*` columns, `record_gen_*_idx` indexes and the sync functions.
Measured on PGlite with 100k rows, filter+sort on an indexed NUMBER attribute is well under the
200 ms p95 budget (test `packages/db/src/objects/objects.test.ts`).
