# ADR-002 — Merge is a first-class, reversible record

**Status:** accepted (Phase 0) · **Spec:** §6.6 decision 2, §10

## Context

Merges must be reversible forever. Reparenting rows in place and hoping to reverse it from an
audit log is not exact: rows created after the merge, field survivorship, and list entries all
interleave.

## Decision

`RecordMerge { winnerId, loserId, mergedById, mergedAt, snapshot, unmergedAt }`. `snapshot`
captures every row that was reparented (timeline event ids, identity ids, conversation ids, list
entries) and every field value overwritten on the winner, with the loser's prior values. The loser
is kept with `mergeState = MERGED` and `mergedIntoId` set; nothing is deleted. `unmerge` replays the
snapshot in reverse inside one transaction and marks `unmergedAt`.

## Consequences

Rows created on the winner after the merge stay with the winner on unmerge (they were never the
loser's). A `NeverMerge` pair is created on unmerge unless the user says otherwise.
