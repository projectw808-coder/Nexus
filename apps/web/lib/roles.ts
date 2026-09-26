/**
 * Client-safe role metadata. `Role` is imported as a type only so client bundles never pull
 * in @nexus/db.
 */
import type { Role } from '@nexus/db';

export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  OWNER: 'Everything, including deleting the workspace.',
  ADMIN: 'Everything except deleting the workspace.',
  MANAGER: 'Reads everything; creates and edits records, lists and conversations.',
  MEMBER: 'Works with records and conversations.',
  VIEWER: 'Read-only.',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Owners and admins manage the workspace, members and invitations (abilities.ts). */
export function canManage(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Owners, admins and managers may read the audit log (`read` on `all`). */
export function canReadAudit(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER';
}

// ── Phase 2: the object graph (mirrors server/abilities.ts; the server decides, this only
// chooses which controls to render) ─────────────────────────────────────────────────────

/** Owners and admins define objects, attributes and shared views (`manage` all). */
export function canEditSchema(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Everyone but viewers creates and edits records and list entries. */
export function canWriteRecords(role: Role): boolean {
  return role !== 'VIEWER';
}

/** Owners, admins and managers delete records, run imports and manage lists. */
export function canDeleteRecords(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER';
}

export const canImport = canDeleteRecords;
export const canManageLists = canDeleteRecords;

/** Viewers are read-only in every sense: no export either. */
export function canExport(role: Role): boolean {
  return role !== 'VIEWER';
}

// ── Phase 6: identity resolution ─────────────────────────────────────────────

/** Owners, admins and managers review the merge queue and merge/unmerge records. */
export const canReviewMerges = canDeleteRecords;

/** Everyone but viewers may link a channel identity to a person (a confirmed, audited link). */
export const canLinkIdentities = canWriteRecords;

// ── Phase 10: automation + AI (mirrors server/abilities.ts) ──────────────────

/** Owners, admins and managers create/edit/enable/delete workflows — they affect the whole team. */
export const canManageWorkflows = canDeleteRecords;

/** Everyone but viewers can trigger AI generation and accept/dismiss what comes back. */
export const canUseAi = canWriteRecords;

// ── Phase 11: the compliance layer (§5.5, mirrors server/abilities.ts) ───────

/** Owners and admins file and decide data-subject requests. */
export const canManageDsr = canManage;

/** Owners, admins and managers record a consent grant or withdrawal. */
export const canRecordConsent = canDeleteRecords;

// ── Phase 11: Reports (mirrors server/abilities.ts) ──────────────────────────

/** Owners, admins and managers build dashboards; everyone else reads them. */
export const canManageDashboards = canDeleteRecords;
