# ADR-006 — RLS is enforced through a non-superuser app role and a per-transaction bypass switch

**Status:** accepted (Phase 1) · **Spec:** §5.1, §5.3

## Context

Postgres row-level security does not apply to superusers, and in the official Docker image the
`POSTGRES_USER` is a superuser. Enabling RLS while the app connects as that user would make the
"belt" decorative. System jobs (retention purge, token refresh sweeps, DSAR, listing a user's
workspaces) legitimately need to see across tenants.

## Decision

- Two roles: `nexus` (table owner, superuser locally) runs migrations via `DATABASE_ADMIN_URL`;
  `nexus_app` (`NOSUPERUSER NOBYPASSRLS`) is what `DATABASE_URL` uses. Created by
  `infra/postgres/init.sql`, the CI workflow, and the PGlite harness. Migrations `GRANT` to it
  conditionally so a cluster without the role still migrates.
- Every tenant table (generated from `TENANT_MODELS`) and `Workspace` get `ENABLE` + `FORCE ROW
LEVEL SECURITY` and one policy: `"workspaceId" = nexus_current_workspace() OR
nexus_rls_bypass()`. `withTenant` sets `app.workspace_id` for the transaction; `withSystem`
  sets `app.rls_bypass = on`. Both are `set_config(…, true)`, so they die with the transaction.
- `withSystem` (like `basePrisma`) is importable only inside `packages/db` and
  `apps/worker/src/system` — the `nexus/no-base-prisma` rule bans it elsewhere. Cross-tenant
  reads apps need (a user's workspaces, actor resolution, invitation acceptance) are functions
  inside `packages/db/src/tenancy.ts`.

## Consequences

An unscoped query returns nothing rather than everything; a mis-scoped insert fails with
`42501`. The PGlite test harness proves both. A new tenant model without a policy fails
`src/rls.test.ts` until `pnpm --filter @nexus/db gen:rls` is run into a new migration.
