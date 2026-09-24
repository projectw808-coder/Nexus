# ADR-007 — "Every mutation writes an audit row" is enforced by the tenant procedure

**Status:** accepted (Phase 1) · **Spec:** §5.4, §11.1, §16 Phase 1

## Context

An audit rule that relies on each author remembering to call a helper decays. The row must also
be in the same transaction as the change, or a failed change leaves a misleading trail.

## Decision

`tenantProcedure` runs the resolver inside `withTenant` and hands it `ctx.audit(entry)`, a
recorder bound to the same transaction. After the resolver returns, a `mutation` whose recorder
count is zero throws `INTERNAL_SERVER_ERROR` — inside the transaction, so the change rolls back.
Mutations that necessarily run outside a tenant scope (creating a workspace, accepting an
invitation) write their rows through `writeSystemAudit` inside `packages/db`, and the generated
test in `apps/web/server/isolation.test.ts` asserts the AuditLog grows for every mutation in the
router manifest, whichever path wrote it.

## Consequences

A new mutation cannot ship without an audit row: it either calls `ctx.audit` or fails in the
first integration test. Reads are not audited (exports will be, §5.4, Phase 11).
