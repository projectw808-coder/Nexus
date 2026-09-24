# apps/worker/src/system

The only place outside `packages/db` where the unscoped `basePrisma` client may be imported
(spec §5.3), enforced by the `nexus/no-base-prisma` ESLint rule. Cross-tenant maintenance jobs
live here: retention purge, token refresh sweeps, drift sampling, DSAR fulfilment. Everything
else in the worker goes through `withTenant()`.
