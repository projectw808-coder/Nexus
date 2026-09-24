'use server';

import { revalidatePath } from 'next/cache';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

export async function renameWorkspaceAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const name = text(formData, 'name');
  if (name.length < 2 || name.length > 80) {
    return fail('Check the highlighted field.', {
      fields: { name: 'Give the workspace a name of 2–80 characters.' },
    });
  }
  try {
    const client = await api(slug);
    const ws = await client.workspace.update({ name });
    revalidatePath(`/w/${slug}`, 'layout');
    return { ok: true, message: `Renamed to ${ws.name}.` };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}
