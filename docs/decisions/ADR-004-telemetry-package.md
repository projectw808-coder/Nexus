# ADR-004 — A dedicated `packages/telemetry`

**Status:** accepted (Phase 0) · **Spec:** §3 layout (deviation), §15

## Context

§3 lists no home for logging and tracing. `packages/core` is domain code and must not depend on
pino or OpenTelemetry; `packages/config` is env and flags. Both apps and the connector SDK need
the same logger shape, redaction list and trace-carrier helpers.

## Decision

Add `@nexus/telemetry` (pino logger with §5.4 redaction paths, OTel NodeSDK bootstrap, BullMQ
trace-context propagation). Apps call `startTelemetry()` first thing; processors run inside
`runWithTraceCarrier()`.

## Consequences

One more package in the workspace. The §3 table is otherwise unchanged; nothing was substituted.
