export { emitTimelineEvent, queryTimeline } from './timeline.ts';
export type { TimelineEventInput, TimelineQuery, TimelineRow, TimelinePage } from './timeline.ts';
export { upsertIdentity, handleHistoryOf, canonicalOf } from './identities.ts';
export type { IdentityUpsertInput, IdentityUpsertResult } from './identities.ts';
export { personAttributes, personSubject, identitySubject, identityLabel } from './subjects.ts';
export type { PersonAttributes } from './subjects.ts';
export { candidatePersonsForIdentity, candidatePersonsForPerson } from './candidates.ts';
export { mergeRecords, unmergeRecords, alternatesFor, isNeverMerge } from './merge.ts';
export type { MergeSnapshot, MergeResult, UnmergeResult, Alternate } from './merge.ts';
export {
  linkIdentity,
  unlinkIdentity,
  createPersonFromIdentity,
  resolveIdentity,
  rescoreSuggestion,
  scanPersonForDuplicates,
  methodLabel,
  platformName,
} from './resolve.ts';
export type { LinkEvidence, LinkResult, ResolveOutcome } from './resolve.ts';
export { listWorkspaceIds } from './workspaces.ts';
