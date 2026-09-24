'use server';

import { filterSchema, sortSchema } from '@nexus/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError, fieldErrorsOf, isCode } from '@/lib/errors';
import { valuesFromForm } from '@/lib/record-form';
import { requireSessionUser } from '@/lib/session';

function tablePath(slug: string, object: string): string {
  return `/w/${slug}/records/${object}`;
}

function failFrom(e: unknown): ActionState {
  const { message, remediation } = describeError(e);
  const fields = fieldErrorsOf(e);
  return fail(message, { remediation, ...(Object.keys(fields).length ? { fields } : {}) });
}

export async function createRecordAction(
  slug: string,
  object: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  let id: string;
  try {
    const client = await api(slug);
    const attrs = await client.attribute.list({ objectType: object });
    const values = valuesFromForm(attrs, formData);
    const created = await client.record.create({ objectType: object, values });
    id = created.id;
    revalidatePath(tablePath(slug, object));
  } catch (e) {
    return failFrom(e);
  }
  redirect(`${tablePath(slug, object)}/${id}`);
}

export async function updateRecordAction(
  slug: string,
  object: string,
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    const attrs = await client.attribute.list({ objectType: object });
    const values = valuesFromForm(attrs, formData);
    await client.record.update({ id, values });
    revalidatePath(tablePath(slug, object));
    revalidatePath(`${tablePath(slug, object)}/${id}`);
  } catch (e) {
    return failFrom(e);
  }
  redirect(`${tablePath(slug, object)}/${id}`);
}

export async function deleteRecordAction(
  slug: string,
  object: string,
  id: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.record.delete({ ids: [id] });
    revalidatePath(tablePath(slug, object));
  } catch (e) {
    return failFrom(e);
  }
  redirect(`${tablePath(slug, object)}?deleted=${encodeURIComponent(id)}`);
}

export async function restoreRecordAction(
  slug: string,
  object: string,
  id: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.record.restore({ ids: [id] });
    revalidatePath(tablePath(slug, object));
    revalidatePath(`${tablePath(slug, object)}/${id}`);
    return { ok: true, message: 'Record restored.' };
  } catch (e) {
    return failFrom(e);
  }
}

function jsonField<T>(formData: FormData, name: string, schema: z.ZodType<T>): T | null {
  const raw = formData.get(name);
  if (typeof raw !== 'string' || !raw) return schema.safeParse([]).data ?? null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** "Save current view": the table's filters and sort, as the typed DSL, under a name. */
export async function saveViewAction(
  slug: string,
  object: string,
  objectTypeId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const name = text(formData, 'name');
  if (name.length < 1 || name.length > 80) {
    return fail('Check the highlighted field.', {
      fields: { name: 'Give the view a name of 1–80 characters.' },
    });
  }
  const isShared = formData.get('shared') === 'on';
  const filters = jsonField(formData, 'filters', z.array(filterSchema).max(20));
  const sorts = jsonField(formData, 'sorts', z.array(sortSchema).max(3));
  if (!filters || !sorts)
    return fail('The current filters could not be read. Reload and try again.');
  try {
    const client = await api(slug);
    await client.view.create({
      objectTypeId,
      name,
      isShared,
      layout: 'TABLE',
      columns: [],
      filters,
      sorts,
    });
    revalidatePath(tablePath(slug, object));
    return { ok: true, message: `Saved “${name}”${isShared ? ' for everyone' : ''}.` };
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) return fail('Only admins can share a view with the workspace.');
    return failFrom(e);
  }
}

export async function deleteViewAction(
  slug: string,
  object: string,
  viewId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.view.delete({ id: viewId });
    revalidatePath(tablePath(slug, object));
    return { ok: true, message: 'View deleted.' };
  } catch (e) {
    return failFrom(e);
  }
}
