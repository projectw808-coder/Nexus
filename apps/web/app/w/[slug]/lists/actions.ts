'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { slugifyIdentifier } from '@/lib/attributes';
import { describeError } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

function listsPath(slug: string): string {
  return `/w/${slug}/lists`;
}

/** "Lead\nQualified\nWon" → stage options; ids are slugs of the labels, deduplicated. */
function parseStages(raw: string): { id: string; label: string }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const label = line.trim();
    if (!label) continue;
    let id = slugifyIdentifier(label) || `stage_${out.length + 1}`;
    while (seen.has(id)) id = `${id}_2`;
    seen.add(id);
    out.push({ id: id.slice(0, 64), label: label.slice(0, 120) });
  }
  return out;
}

export async function createListAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const objectType = text(formData, 'objectType');
  const name = text(formData, 'name');
  const kindRaw = text(formData, 'kind');
  const kind = kindRaw === 'PIPELINE' || kindRaw === 'COLLECTION' ? kindRaw : null;
  const description = text(formData, 'description');
  const stages = parseStages(text(formData, 'stages'));

  const fields: Record<string, string> = {};
  if (!objectType) fields.objectType = 'Pick the object this list holds.';
  if (name.length < 1 || name.length > 80) fields.name = 'Give the list a name of 1–80 characters.';
  if (!kind) fields.kind = 'Pick pipeline or collection.';
  if (kind === 'PIPELINE' && stages.length === 0)
    fields.stages = 'A pipeline needs at least one stage, one per line.';
  if (Object.keys(fields).length || !kind) return fail('Check the highlighted fields.', { fields });

  let id: string;
  try {
    const client = await api(slug);
    const created = await client.list.create({
      objectType,
      name,
      kind,
      ...(kind === 'PIPELINE' ? { stages } : {}),
      ...(description ? { description } : {}),
    });
    id = created.id;
    revalidatePath(listsPath(slug));
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
  redirect(`${listsPath(slug)}/${id}`);
}

export async function deleteListAction(
  slug: string,
  listId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.list.delete({ id: listId });
    revalidatePath(listsPath(slug));
  } catch (e) {
    const { message, remediation } = describeError(e);
    return fail(message, { remediation });
  }
  redirect(listsPath(slug));
}
