/**
 * CASL abilities derived from role + per-connection grants (§5.2). One ability object per
 * request; checked in tRPC middleware, in serializers (Phase 2 field-level) and in the export
 * job (Phase 11). Connection permissions are conditioned on the connection id so a member can
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
  | 'export';

export type SubjectName =
  | 'Workspace'
  | 'Membership'
  | 'Invitation'
  | 'AuditLog'
  | 'Connection'
  | 'ConnectionGrant'
  | 'ApiKey'
  | 'Record'
  | 'List'
  | 'Conversation'
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
      can(['create', 'update', 'delete'], ['Record', 'List', 'Conversation']);
      can('export', ['Record', 'List', 'Conversation']);
      cannot('read', ['ApiKey', 'ConnectionGrant']);
      break;
    case 'MEMBER':
      can('read', ['Workspace', 'Membership', 'Record', 'List', 'Conversation', 'Connection']);
      can(['create', 'update'], ['Record', 'Conversation']);
      can('update', 'List');
      break;
    case 'VIEWER':
      can('read', ['Workspace', 'Membership', 'Record', 'List', 'Conversation', 'Connection']);
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
