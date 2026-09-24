# @nexus/db

Prisma 7 schema, migrations and the database client for Nexus. This package is
the tenant-isolation boundary: nothing outside it may talk to Postgres directly.

## Layout

```
prisma.config.ts                 Prisma 7 config: schema path, migrations path, seed, DATABASE_URL
prisma/schema.prisma             the data model (§6 of the spec), sections §6.1–§6.6 + Auth.js
prisma/migrations/               migration history; migration_lock.toml pins postgresql
prisma/drift-allowlist.json      DB objects that live outside schema.prisma (see Drift gate)
prisma/seed.ts                   seed entry (stub until Appendix B lands)
scripts/gen-tenant-models.ts     regenerates src/generated-tenant-models.ts (see Tenant models)
src/generated/prisma/            generated client — gitignored, produced by `pnpm generate`
src/generated-tenant-models.ts   checked-in, generated: TENANT_MODELS
src/client.ts                    basePrisma — unscoped, @internal
src/health.ts                    checkDatabase()
src/index.ts                     public surface
```

## Schema conventions

- Every model: `id String @id @default(uuid())`, `createdAt`, `updatedAt`, and
  `deletedAt` (soft delete). Append-only logs (AuditLog, WebhookEvent, SyncRun,
  WorkflowRun, ListStageHistory, ConnectionDriftSample, OutboundWebhookDelivery,
  RecordMerge, Embedding) omit `deletedAt` and say so in a comment.
- Every tenant-owned model has `workspaceId` with `onDelete: Cascade`, and
  `workspaceId` is the first column of every composite index and unique.
  Non-tenant models are only `Workspace` (the tenant root), `User`, the Auth.js
  tables (`Account`, `Session`, `VerificationToken`) and `PlatformComplianceNote`.
- Prisma 7: the datasource has no `url`; it is supplied by `prisma.config.ts`
  from `DATABASE_URL`. The generator is `prisma-client` (ESM, `.ts` output) and
  the client is built with the `pg` driver adapter.
- `Platform` is mirrored verbatim in `packages/connectors/sdk`. Change both.

Generated-client import paths (inside this package only):

```ts
import { PrismaClient, Prisma } from './generated/prisma/client.ts';
import { Platform, Role } from './generated/prisma/enums.ts';
import type { Record, Conversation } from './generated/prisma/models.ts';
```

Consumers import from `@nexus/db`, which re-exports enums, model types, the
`Prisma` namespace (type-only), `checkDatabase` and `TENANT_MODELS`. It does
not export `basePrisma` or the `PrismaClient` value on purpose.

## Migrations

```sh
pnpm --filter @nexus/db generate        # prisma generate + tenant-model file
pnpm --filter @nexus/db migrate:dev     # create/apply a migration locally
pnpm --filter @nexus/db migrate:deploy  # apply pending migrations (CI / prod)
```

Some objects cannot be expressed in `schema.prisma`: the `jsonb_path_ops` GIN
on `Record.values`, the tsvector GIN, the HNSW indexes on `vector(1536)`
columns, trigram indexes, the `nexus_current_workspace()` RLS helper, and (from
Phase 1) the RLS policies and the generated btree columns the `index.build` job
adds for `Attribute.isIndexed`. Those are hand-written SQL placed **below** a
`-- nexus:managed-outside-schema` marker at the end of a migration; the part
above the marker is the verbatim `prisma migrate diff` output and is never
edited by hand. When you add such an object, also add its name (or a pattern)
to `prisma/drift-allowlist.json`.

Creating the initial migration without a database (how `20260924000000_init`
was produced):

```sh
prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script -o migration.sql
# then append the managed-outside-schema section
```

## Drift gate (§15)

```sh
SHADOW_DATABASE_URL=postgresql://… pnpm --filter @nexus/db drift
```

This replays `prisma/migrations` into the shadow database and diffs it against
`schema.prisma`; exit code 2 means drift. Because the hand-written objects are
not in the schema, Prisma reports them as things to drop. The CI gate wrapper
filters those statements using `prisma/drift-allowlist.json` (exact names under
`indexes` / `functions` / `extensions`, regexes under `patterns`) before
deciding pass/fail. Anything else in the diff — a column, an index, a
constraint the schema does not know about — fails the build.

## Tenant models

The scoped client (§5.3) must never forget a model, so `TENANT_MODELS` is not
written by hand. `scripts/gen-tenant-models.ts` reads the Prisma runtime data
model out of the generated client (Prisma 7 no longer exposes `Prisma.dmmf`,
but it inlines the same DMMF datamodel subset as `config.runtimeDataModel` in
`src/generated/prisma/internal/class.ts`), keeps every model that has a
`workspaceId` field, and writes `src/generated-tenant-models.ts`. It runs as
part of `pnpm generate`.

`src/tenant-models.test.ts` recomputes the set from the generated client and
from an independent parse of `schema.prisma`, and fails if the checked-in file
is stale or if a model without `workspaceId` is not on the explicit
`NON_TENANT_ALLOWLIST` in `scripts/tenant-models-from-dmmf.ts`. Add a model,
run `pnpm generate`, commit the result.

## Health

`checkDatabase()` runs `SELECT 1` with a 2s timeout and returns
`{ ok: true, latencyMs }` or `{ ok: false, error }`. It imports the client
lazily, so importing `@nexus/db` for enums/types does not need `DATABASE_URL`.

## Seed

`pnpm --filter @nexus/db seed` runs `prisma/seed.ts`. It is a stub until the
Appendix B seed (system object types, protected attributes, demo workspace,
mock connection) lands in Phase 2.
