'use server';

import { redirect } from 'next/navigation';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError, isCode } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';
import { isValidSlug, SLUG_HELP } from '@/lib/slug';

export async function createWorkspaceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();

  const name = text(formData, 'name');
  const slug = text(formData, 'slug').toLowerCase();

  const fields: Record<string, string> = {};
  if (name.length < 2 || name.length > 80)
    fields.name = 'Give the workspace a name of 2–80 characters.';
  if (!isValidSlug(slug)) fields.slug = SLUG_HELP;
  if (Object.keys(fields).length) return fail('Check the highlighted fields.', { fields });

  let target: string;
  try {
    const client = await api();
    const ws = await client.workspace.create({ name, slug });
    target = ws.slug;
  } catch (e) {
    if (isCode(e, 'CONFLICT')) {
      return fail('That slug is already taken.', {
        fields: { slug: 'That slug is already taken. Try another.' },
      });
    }
    if (isCode(e, 'BAD_REQUEST')) {
      const { message } = describeError(e);
      return fail(message, { fields: { slug: message } });
    }
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
  redirect(`/w/${target}`);
}
