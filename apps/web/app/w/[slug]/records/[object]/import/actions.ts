'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

const MAX_BYTES = 8 * 1024 * 1024;

function importPath(slug: string, object: string): string {
  return `/w/${slug}/records/${object}/import`;
}

function failFrom(e: unknown): ActionState {
  const { message, remediation } = describeError(e);
  return fail(message, { remediation });
}

/** Step 1: read the uploaded file and create the job (which returns the dry-run preview). */
export async function uploadCsvAction(
  slug: string,
  object: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0)
    return fail('Choose a CSV file.', { fields: { file: 'Required.' } });
  if (file.size > MAX_BYTES)
    return fail('Files are limited to 8 MB.', { fields: { file: 'Too large.' } });
  let jobId: string;
  try {
    const csvText = await file.text();
    const client = await api(slug);
    const created = await client.import.create({
      objectType: object,
      fileName: file.name,
      csvText,
    });
    jobId = created.id;
  } catch (e) {
    return failFrom(e);
  }
  redirect(`${importPath(slug, object)}/${jobId}`);
}

/** Step 2: re-run the dry run with the mapping and options from the form. */
export async function previewAction(
  slug: string,
  object: string,
  jobId: string,
  headers: string[],
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const mapping: Record<string, { attributeId: string } | { skip: true }> = {};
  for (const h of headers) {
    const v = text(formData, `map:${h}`);
    mapping[h] = v && v !== 'skip' ? { attributeId: v } : { skip: true };
  }
  const dedupe = text(formData, 'dedupeAttributeId');
  try {
    const client = await api(slug);
    await client.import.preview({
      id: jobId,
      mapping,
      options: {
        dedupeAttributeId: dedupe || null,
        updateExisting: formData.get('updateExisting') === 'on',
      },
    });
    revalidatePath(`${importPath(slug, object)}/${jobId}`);
    return { ok: true, message: 'Preview updated.' };
  } catch (e) {
    return failFrom(e);
  }
}

/** Plain-form variant of previewAction for a server-rendered form (no useActionState). */
export async function previewFormAction(
  slug: string,
  object: string,
  jobId: string,
  headers: string[],
  formData: FormData,
): Promise<void> {
  const r = await previewAction(slug, object, jobId, headers, { ok: true }, formData);
  if (!r.ok)
    redirect(`${importPath(slug, object)}/${jobId}?error=${encodeURIComponent(r.message)}`);
}

export async function runImportAction(
  slug: string,
  object: string,
  jobId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    const stats = await client.import.run({ id: jobId });
    revalidatePath(`${importPath(slug, object)}/${jobId}`);
    revalidatePath(`/w/${slug}/records/${object}`);
    return {
      ok: true,
      message: `Imported ${stats.created} new, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.failed} failed.`,
    };
  } catch (e) {
    return failFrom(e);
  }
}

export async function rollbackImportAction(
  slug: string,
  object: string,
  jobId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    const r = await client.import.rollback({ id: jobId });
    revalidatePath(`${importPath(slug, object)}/${jobId}`);
    revalidatePath(`/w/${slug}/records/${object}`);
    return {
      ok: true,
      message: `Rolled back: ${r.removed} ${r.removed === 1 ? 'record' : 'records'} removed.`,
    };
  } catch (e) {
    return failFrom(e);
  }
}
