/**
 * CASL abilities derived from role + per-connection grants (§5.2). One ability object per
 * request; checked in tRPC middleware, in serializers (field-level via attributeAccess) and in
 * the export job. Connection permissions are conditioned on the connection id so a member can
 * be `engage` on Instagram and `read`-only on LinkedIn.
 */
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import type { Actor, Role } from '@nexus/db';

export type Action =
  | 'manage'
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'invite'
  | 'change_role'
  | 'remove'
  | 'engage'
  | 'publish'
  | 'configure'
  | 'export'
  | 'import';

export type SubjectName =
  | 'Workspace'
  | 'Membership'
  | 'Invitation'
  | 'AuditLog'
  | 'Connection'
  | 'ConnectionGrant'
  | 'ApiKey'
  | 'ObjectType'
  | 'Attribute'
  | 'Record'
  | 'List'
  | 'ListEntry'
  | 'SavedView'
  | 'ImportJob'
  | 'Conversation'
  | 'Note'
  | 'Task'
  | 'Identity'
  | 'MergeSuggestion'
  | 'RecordMerge'
  | 'CannedReply'
  | 'all';

export type ConnectionSubject = { kind: 'Connection'; id: string };
export type Subject = SubjectName | ConnectionSubject;

export type AppAbility = MongoAbility<[Action, Subject]>;

const ROLE_RANK: Record<Role, number> = { OWNER: 5, ADMIN: 4, MANAGER: 3, MEMBER: 2, VIEWER: 1 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Roles a given role may assign to others (never above itself; only owners hand out OWNER). */
export function assignableRoles(by: Role): Role[] {
  if (by === 'OWNER') return ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];
  if (by === 'ADMIN') return ['ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];
  return [];
}

export function defineAbilityFor(actor: Actor): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  switch (actor.role) {
    case 'OWNER':
      can('manage', 'all');
      break;
    case 'ADMIN':
      can('manage', 'all');
      cannot('delete', 'Workspace');
      break;
    case 'MANAGER':
      can('read', 'all');
      can(
        ['create', 'update', 'delete', 'export', 'import'],
        ['Record', 'List', 'ListEntry', 'Conversation', 'ImportJob', 'Note', 'Task'],
      );
      can(['create', 'update', 'delete'], 'SavedView');
      // Managers resolve identities, review the merge queue and merge/unmerge records.
      can(['update', 'delete'], ['Identity', 'MergeSuggestion', 'RecordMerge']);
      can(['create', 'update', 'delete'], 'CannedReply');
      cannot('read', ['ApiKey', 'ConnectionGrant']);
      break;
    case 'MEMBER':
      can('read', [
        'Workspace',
        'Membership',
        'ObjectType',
        'Attribute',
        'Record',
        'List',
        'ListEntry',
        'SavedView',
        'Conversation',
        'Connection',
        'Note',
        'Task',
        'Identity',
        'MergeSuggestion',
        'RecordMerge',
        'CannedReply',
      ]);
      can(['create', 'update'], ['Record', 'Conversation', 'ListEntry', 'Note', 'Task']);
      can('delete', 'Task');
      // Members may say "this handle is that person" — a confirmed, audited link.
      can('update', 'Identity');
      can(['create', 'update'], 'CannedReply');
      can('export', 'Record');
      can(['create', 'update', 'delete'], 'SavedView');
      break;
    case 'VIEWER':
      can('read', [
        'Workspace',
        'Membership',
        'ObjectType',
        'Attribute',
        'Record',
        'List',
        'ListEntry',
        'SavedView',
        'Conversation',
        'Connection',
        'Note',
        'Task',
        'Identity',
        'MergeSuggestion',
        'RecordMerge',
        'CannedReply',
      ]);
      break;
  }

  // Per-connection grants add, never remove. Owners/admins already manage every connection.
  for (const g of actor.grants) {
    const action = g.permission.toLowerCase() as 'read' | 'engage' | 'publish' | 'configure';
    can(action, 'Connection', { id: g.connectionId });
  }

  return build({
    detectSubjectType: (s: Subject) => (typeof s === 'string' ? s : s.kind),
  });
}

/** Handy for connection checks: `ability.can('engage', connection(id))`. */
export function connection(id: string): ConnectionSubject {
  return { kind: 'Connection', id };
}
