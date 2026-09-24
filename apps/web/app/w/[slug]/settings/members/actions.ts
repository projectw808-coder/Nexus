'use server';

import { revalidatePath } from 'next/cache';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { isRole, ROLE_LABEL } from '@/lib/roles';
import { requireSessionUser } from '@/lib/session';

function membersPath(slug: string): string {
  return `/w/${slug}/settings/members`;
}

export async function changeRoleAction(
  slug: string,
  membershipId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const role = text(formData, 'role');
  if (!isRole(role)) return fail('Pick a role from the list.');
  try {
    const client = await api(slug);
    const updated = await client.member.changeRole({ membershipId, role });
    revalidatePath(membersPath(slug));
    return { ok: true, message: `Role changed to ${ROLE_LABEL[updated.role]}.` };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}

export async function removeMemberAction(
  slug: string,
  membershipId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.member.remove({ membershipId });
    revalidatePath(membersPath(slug));
    return { ok: true, message: 'Member removed.' };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}

export async function inviteAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const email = text(formData, 'email').toLowerCase();
  const role = text(formData, 'role');
  const fields: Record<string, string> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address.';
  if (!isRole(role)) fields.role = 'Pick a role from the list.';
  if (Object.keys(fields).length || !isRole(role))
    return fail('Check the highlighted fields.', { fields });
  try {
    const client = await api(slug);
    const inv = await client.invitation.create({ email, role });
    revalidatePath(membersPath(slug));
    return {
      ok: true,
      message: `Invitation sent to ${inv.email} as ${ROLE_LABEL[inv.role].toLowerCase()}.`,
    };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}

export async function revokeInvitationAction(
  slug: string,
  invitationId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.invitation.revoke({ invitationId });
    revalidatePath(membersPath(slug));
    return { ok: true, message: 'Invitation revoked.' };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}
