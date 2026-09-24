'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { ATTRIBUTE_SLUG_HELP, isValidIdentifier } from '@/lib/attributes';
import { describeError, isCode } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

function objectsPath(slug: string): string {
  return `/w/${slug}/settings/objects`;
}

export async function createObjectAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const apiSlug = text(formData, 'apiSlug').toLowerCase();
  const singular = text(formData, 'singular');
  const plural = text(formData, 'plural');
  const icon = text(formData, 'icon');
  const description = text(formData, 'description');

  const fields: Record<string, string> = {};
  if (!isValidIdentifier(apiSlug)) fields.apiSlug = ATTRIBUTE_SLUG_HELP;
  if (singular.length < 1 || singular.length > 60)
    fields.singular = 'Give it a singular name of 1–60 characters.';
  if (plural.length < 1 || plural.length > 60)
    fields.plural = 'Give it a plural name of 1–60 characters.';
  if (Object.keys(fields).length) return fail('Check the highlighted fields.', { fields });

  let created: { apiSlug: string };
  try {
    const client = await api(slug);
    created = await client.objectType.create({
      apiSlug,
      singular,
      plural,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
    });
    revalidatePath(objectsPath(slug));
    revalidatePath(`/w/${slug}/records`);
  } catch (e) {
    const { message, remediation } = describeError(e);
    if (isCode(e, 'CONFLICT')) return fail(message, { fields: { apiSlug: message } });
    return fail(message, { remediation });
  }
  redirect(`${objectsPath(slug)}/${created.apiSlug}`);
}

export async function deleteObjectAction(
  slug: string,
  objectTypeId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.objectType.delete({ id: objectTypeId });
    revalidatePath(objectsPath(slug));
    revalidatePath(`/w/${slug}/records`);
    return { ok: true, message: 'Object deleted. Its attributes stay restorable for 24 hours.' };
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
}
