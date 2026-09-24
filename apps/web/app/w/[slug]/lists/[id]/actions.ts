'use server';

import { revalidatePath } from 'next/cache';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { isUuid } from '@/lib/attributes';
import { describeError, messageOf } from '@/lib/errors';
import { requireSessionUser } from '@/lib/session';

function listPath(slug: string, listId: string): string {
  return `/w/${slug}/lists/${listId}`;
}

function failFrom(e: unknown): ActionState {
  const { message, remediation } = describeError(e);
  return fail(message, { remediation });
}

export async function addEntryAction(
  slug: string,
  listId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const recordId = text(formData, 'recordId');
  const stage = text(formData, 'stage');
  if (!isUuid(recordId))
    return fail('Pick a record first.', {
      fields: { recordId: 'Pick a record from the search results.' },
    });
  try {
    const client = await api(slug);
    const e = await client.listEntry.add({ listId, recordId, ...(stage ? { stage } : {}) });
    revalidatePath(listPath(slug, listId));
    return { ok: true, message: e.stage ? `Added to ${e.stage}.` : 'Added.' };
  } catch (e) {
    return failFrom(e);
  }
}

/** Stage change from the per-card `<select>`. */
export async function moveStageAction(
  slug: string,
  listId: string,
  entryId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const stage = text(formData, 'stage');
  if (!stage) return fail('Pick a stage.');
  try {
    const client = await api(slug);
    await client.listEntry.move({ entryId, stage });
    revalidatePath(listPath(slug, listId));
    return { ok: true, message: `Moved to ${stage}.` };
  } catch (e) {
    return failFrom(e);
  }
}

/** Up/Down within a stage: `before` places the entry before that neighbour, `after` after it. */
export async function nudgeEntryAction(
  slug: string,
  listId: string,
  entryId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const before = text(formData, 'before');
  const after = text(formData, 'after');
  if (!isUuid(before) && !isUuid(after)) return fail('Nothing to move past.');
  try {
    const client = await api(slug);
    await client.listEntry.move({
      entryId,
      ...(isUuid(before) ? { beforeEntryId: before } : {}),
      ...(isUuid(after) ? { afterEntryId: after } : {}),
    });
    revalidatePath(listPath(slug, listId));
    return { ok: true };
  } catch (e) {
    return failFrom(e);
  }
}

export async function removeEntryAction(
  slug: string,
  listId: string,
  entryId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.listEntry.remove({ entryId });
    revalidatePath(listPath(slug, listId));
    return { ok: true, message: 'Removed from the list.' };
  } catch (e) {
    return failFrom(e);
  }
}

export type HistoryItem = {
  id: string;
  fromStage: string | null;
  toStage: string | null;
  at: string;
  by: string | null;
};
export type HistoryResult = { ok: true; items: HistoryItem[] } | { ok: false; message: string };

/** Stage history, fetched when the entry's `<details>` opens. */
export async function entryHistoryAction(slug: string, entryId: string): Promise<HistoryResult> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    const rows = await client.listEntry.history({ entryId });
    return {
      ok: true,
      items: rows.map((h) => ({
        id: h.id,
        fromStage: h.fromStage,
        toStage: h.toStage,
        at: new Date(h.at).toISOString(),
        by: h.by,
      })),
    };
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  }
}
