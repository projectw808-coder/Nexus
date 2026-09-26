/** Phase 11 — the compliance layer (§5.5, ADR-022). */
export {
  getConsent,
  recordConsent,
  listConsent,
  listConsentForIdentity,
  consentCounts,
  consentAllowsSend,
  NON_PLATFORM_CONSENT_CHANNELS,
} from './consent.ts';
export type {
  ConsentAuditSink,
  ConsentChannel,
  ConsentDecision,
  ConsentListRow,
  ConsentRow,
  NonPlatformConsentChannel,
  OutboundConsentTarget,
  RecordConsentInput,
} from './consent.ts';

export { purgeConnectionRetention, RETENTION_TABLES } from './retention.ts';
export type { ConnectionPurge, RetentionPurgeResult, RetentionTable } from './retention.ts';

export {
  runDataSubjectRequest,
  resolveSubjectScope,
  buildSubjectExport,
  eraseSubject,
} from './dsr.ts';
export type { RunDsrResult, SubjectScope, SubjectSelector, TombstoneEntry } from './dsr.ts';

export {
  getExportStorage,
  setExportStorage,
  s3ConfigFromEnv,
  MemoryExportStorage,
  S3ExportStorage,
} from './storage.ts';
export type { ExportStorage, PutResult, S3Config } from './storage.ts';

export {
  PLATFORM_COMPLIANCE_NOTES,
  seedPlatformComplianceNotes,
  listComplianceNotes,
} from './notes.ts';
export type { ComplianceNoteRow, ComplianceNoteSeed } from './notes.ts';
