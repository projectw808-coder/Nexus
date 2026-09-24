# ADR-005 — Lanes are BullMQ priorities inside stage queues

**Status:** accepted (Phase 0) · **Spec:** §4, §7.3

## Context

§4 defines queues per pipeline stage; §7.3 defines four lanes by urgency (interactive > webhook >
delta > backfill) and requires that backfill yield budget to the lanes above it.

## Decision

Queues stay per stage (`QUEUES` in `@nexus/config`). Each job carries a lane, mapped to a BullMQ
priority (`LANE_PRIORITY`: 1..4). The rate limiter's reservation also takes the lane, so an
interactive reservation can pre-empt a backfill reservation on the same connection even when both
are already dequeued.

## Consequences

One worker pool per queue; no queue × lane explosion. Prioritised jobs cost O(log n) in Redis,
acceptable at our volumes. If a single queue ever needs isolated concurrency per lane, split that
queue only — the constants make this a one-line change for producers.
