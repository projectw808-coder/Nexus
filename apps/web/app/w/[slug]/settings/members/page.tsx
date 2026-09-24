import { ConfirmAction } from '@/components/confirm-action';
import { DataTable, Td, Th } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PermissionDenied, PermissionNote } from '@/components/permission-denied';
import { RoleBadge } from '@/components/role-badge';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { formatDate, formatDateTime, isoOf } from '@/lib/format';
import { canManage, ROLE_LABEL } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { assignableRoles } from '@/server/abilities';
import {
  changeRoleAction,
  inviteAction,
  removeMemberAction,
  revokeInvitationAction,
} from './actions';
import { InviteForm } from './invite-form';
import { MemberRoleSelect } from './member-role-select';

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  const manages = canManage(workspace.role);
  const assignable = assignableRoles(workspace.role);

  let members;
  try {
    members = await client.member.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Members are hidden from your role"
          description="Reading the member list needs a role that can see memberships."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }

  // Invitations are readable by owners, admins and managers; others simply do not see the section.
  let invitations: Awaited<ReturnType<typeof client.invitation.list>> | null = null;
  try {
    invitations = await client.invitation.list();
  } catch (e) {
    if (!isCode(e, 'FORBIDDEN')) throw e;
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="members-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="members-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Members <span className="tnum font-normal text-ink-muted">({members.length})</span>
          </h2>
        </div>
        {!manages ? (
          <PermissionNote>
            Only owners and admins can change roles or remove members. You are a{' '}
            {workspace.role.toLowerCase()}.
          </PermissionNote>
        ) : null}
        <DataTable
          caption="Workspace members"
          head={
            <>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              {manages ? (
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              ) : null}
            </>
          }
        >
          {members.map((m) => {
            const label = m.name ?? m.email;
            const roleLocked = m.isSelf
              ? 'You cannot change your own role.'
              : !assignable.includes(m.role)
                ? `Your role cannot change a ${ROLE_LABEL[m.role].toLowerCase()}.`
                : undefined;
            const removeLocked = m.isSelf
              ? 'You cannot remove yourself.'
              : !assignable.includes(m.role)
                ? `Your role cannot remove a ${ROLE_LABEL[m.role].toLowerCase()}.`
                : undefined;
            return (
              <tr key={m.id} className="hover:bg-raised">
                <Td>
                  <span className="font-medium">
                    {m.name ?? <span className="text-ink-muted">—</span>}
                  </span>
                  {m.isSelf ? (
                    <span className="ml-2 text-[var(--text-xs)] text-ink-muted">you</span>
                  ) : null}
                </Td>
                <Td className="text-ink-secondary">{m.email}</Td>
                <Td>
                  {manages ? (
                    <MemberRoleSelect
                      action={changeRoleAction.bind(null, workspace.slug, m.id)}
                      role={m.role}
                      assignable={assignable}
                      disabled={!!roleLocked}
                      disabledReason={roleLocked}
                      memberLabel={label}
                    />
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                </Td>
                <Td className="tnum text-ink-secondary">
                  {m.joinedAt ? (
                    <time dateTime={isoOf(m.joinedAt)}>{formatDate(m.joinedAt)}</time>
                  ) : (
                    '—'
                  )}
                </Td>
                {manages ? (
                  <Td align="right">
                    <ConfirmAction
                      label="Remove"
                      question={
                        <>
                          Remove {label} from {workspace.name}?
                        </>
                      }
                      confirmLabel="Remove member"
                      action={removeMemberAction.bind(null, workspace.slug, m.id)}
                      disabled={!!removeLocked}
                      disabledReason={removeLocked}
                    />
                  </Td>
                ) : null}
              </tr>
            );
          })}
        </DataTable>
      </section>

      {invitations ? (
        <section aria-labelledby="invitations-heading" className="flex flex-col gap-3">
          <h2
            id="invitations-heading"
            className="text-[var(--text-md)] font-semibold tracking-tight"
          >
            Pending invitations{' '}
            <span className="tnum font-normal text-ink-muted">({invitations.length})</span>
          </h2>
          {invitations.length === 0 ? (
            <EmptyState
              compact
              title="No pending invitations"
              description={
                manages
                  ? 'Invite someone below; the link they receive is valid for 7 days.'
                  : 'Owners and admins can invite people.'
              }
            />
          ) : (
            <DataTable
              caption="Pending invitations"
              head={
                <>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Invited by</Th>
                  <Th>Expires</Th>
                  {manages ? (
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  ) : null}
                </>
              }
            >
              {invitations.map((i) => (
                <tr key={i.id} className="hover:bg-raised">
                  <Td className="font-medium">{i.email}</Td>
                  <Td>
                    <RoleBadge role={i.role} />
                  </Td>
                  <Td className="text-ink-secondary">{i.invitedBy ?? '—'}</Td>
                  <Td className="tnum text-ink-secondary">
                    <time dateTime={isoOf(i.expiresAt)}>{formatDateTime(i.expiresAt)}</time>
                    {i.expired ? (
                      <span className="ml-2 text-warning">
                        <span aria-hidden>△ </span>expired
                      </span>
                    ) : null}
                  </Td>
                  {manages ? (
                    <Td align="right">
                      <ConfirmAction
                        label="Revoke"
                        question={<>Revoke the invitation for {i.email}?</>}
                        confirmLabel="Revoke invitation"
                        action={revokeInvitationAction.bind(null, workspace.slug, i.id)}
                      />
                    </Td>
                  ) : null}
                </tr>
              ))}
            </DataTable>
          )}
        </section>
      ) : null}

      {manages ? (
        <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
          <h2 id="invite-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Invite someone
          </h2>
          <InviteForm action={inviteAction.bind(null, workspace.slug)} assignable={assignable} />
        </section>
      ) : null}
    </div>
  );
}
