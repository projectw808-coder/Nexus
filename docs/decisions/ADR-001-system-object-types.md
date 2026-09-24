# ADR-001 — Person, Company and Deal are ObjectType rows, not tables

**Status:** accepted (Phase 0) · **Spec:** §6.6 decision 1

## Context

The object graph is user-extensible (§6.2). Giving the three system objects their own tables would
mean two storage paths, two permission models and two query planners for what the UI presents as
one thing.

## Decision

`Person`, `Company` and `Deal` are seeded `ObjectType` rows with `isSystem = true` and protected
attributes (`email`, `phone`, `name`, `domain`, `amount`, `stage`). The `person`, `company` and
`deal` tRPC routers are typed conveniences over the generic `record` router and introduce no
parallel storage. System attributes may be relabelled but never deleted or retyped; the attribute
mutation enforces `Attribute.isSystem` and a test covers it, because §10 Tier-1 matching depends on
those slugs.

## Consequences

Hot attribute filters rely on the generated-column strategy in ADR-006 (Phase 2). Identity
resolution reads `Record.values.email` etc. by slug and can trust their type.
