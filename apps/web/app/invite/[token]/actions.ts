'use server';

import { redirect } from 'next/navigation';
import { fail, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

export async function acceptInvitationAction(
  token: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  let slug: string;
  try {
    const client = await api();
    const result = await client.invitation.accept({ token });
    slug = result.slug;
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
  redirect(`/w/${slug}`);
}
