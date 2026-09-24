'use server';

import type { AttributeType } from '@nexus/core';
import type { AttributeAccess } from '@nexus/db';
import { revalidatePath } from 'next/cache';
import { fail, text, type ActionState } from '@/lib/action-state';
import { api } from '@/lib/api';
import { ATTRIBUTE_SLUG_HELP, CREATABLE_TYPES, isValidIdentifier } from '@/lib/attributes';
import { describeError, fieldErrorsOf, isCode } from '@/lib/errors';
import { isRole } from '@/lib/roles';
import { requireSessionUser } from '@/lib/session';

function objectPath(slug: string, object: string): string {
  return `/w/${slug}/settings/objects/${object}`;
}

function failFrom(e: unknown): ActionState {
  const { message, remediation } = describeError(e);
  const fields = fieldErrorsOf(e);
  return fail(message, { remediation, ...(Object.keys(fields).length ? { fields } : {}) });
}

function revalidate(slug: string, object: string): void {
  revalidatePath(objectPath(slug, object));
  revalidatePath(`/w/${slug}/records/${object}`);
}

/** Per-type config from the attribute form's fields. */
function configFrom(type: AttributeType, formData: FormData): Record<string, unknown> {
  switch (type) {
    case 'SELECT':
    case 'MULTISELECT':
    case 'STATUS': {
      const raw = text(formData, 'options');
      const options = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [labelPart, colorPart] = line.split('|').map((s) => s.trim());
          const label = labelPart ?? line;
          const id =
            label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 64) || 'option';
          return { id, label, ...(colorPart ? { color: colorPart } : {}) };
        });
      return { options };
    }
    case 'CURRENCY':
      return { currency: (text(formData, 'currency') || 'USD').toUpperCase() };
    case 'RATING':
      return { max: Number(text(formData, 'max') || 5) };
    case 'RELATIONSHIP':
      return {
        targetObjectTypeId: text(formData, 'targetObjectTypeId'),
        multiple: formData.get('multiple') === 'on',
      };
    case 'USER':
      return { multiple: formData.get('multiple') === 'on' };
    case 'TEXT':
      return { multiline: formData.get('multiline') === 'on' };
    default:
      return {};
  }
}

export async function createAttributeAction(
  slug: string,
  object: string,
  objectTypeId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const title = text(formData, 'title');
  const apiSlug = text(formData, 'apiSlug').toLowerCase();
  const type = text(formData, 'type') as AttributeType;
  const fields: Record<string, string> = {};
  if (title.length < 1 || title.length > 80) fields.title = 'Give it a title of 1–80 characters.';
  if (!isValidIdentifier(apiSlug)) fields.apiSlug = ATTRIBUTE_SLUG_HELP;
  if (!CREATABLE_TYPES.includes(type)) fields.type = 'Pick a type.';
  if (Object.keys(fields).length) return fail('Check the highlighted fields.', { fields });
  try {
    const client = await api(slug);
    await client.attribute.create({
      objectTypeId,
      apiSlug,
      title,
      type,
      config: configFrom(type, formData),
      description: text(formData, 'description') || undefined,
      isRequired: formData.get('isRequired') === 'on',
      isUnique: formData.get('isUnique') === 'on',
      isIndexed: formData.get('isIndexed') === 'on',
    });
    revalidate(slug, object);
    return { ok: true, message: `${title} added.` };
  } catch (e) {
    if (isCode(e, 'CONFLICT'))
      return fail(describeError(e).message, { fields: { apiSlug: describeError(e).message } });
    return failFrom(e);
  }
}

export async function updateAttributeAction(
  slug: string,
  object: string,
  attributeId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const title = text(formData, 'title');
  if (title.length < 1 || title.length > 80)
    return fail('Give it a title of 1–80 characters.', {
      fields: { title: 'Required, up to 80 characters.' },
    });
  try {
    const client = await api(slug);
    await client.attribute.update({
      id: attributeId,
      title,
      description: text(formData, 'description') || null,
      isRequired: formData.get('isRequired') === 'on',
      isUnique: formData.get('isUnique') === 'on',
    });
    revalidate(slug, object);
    return { ok: true, message: 'Saved.' };
  } catch (e) {
    return failFrom(e);
  }
}

export async function setIndexedAction(
  slug: string,
  object: string,
  attributeId: string,
  indexed: boolean,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    const r = await client.attribute.setIndexed({ id: attributeId, indexed });
    revalidate(slug, object);
    return {
      ok: true,
      message: indexed
        ? `Index ${r.indexState === 'READY' ? 'ready' : 'building in the background'}.`
        : 'Index removal queued.',
    };
  } catch (e) {
    return failFrom(e);
  }
}

export async function reorderAttributeAction(
  slug: string,
  object: string,
  objectTypeId: string,
  orderedIds: string[],
  attributeId: string,
  direction: 'up' | 'down',
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const ids = [...orderedIds];
  const i = ids.indexOf(attributeId);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return { ok: true };
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  try {
    const client = await api(slug);
    await client.attribute.reorder({ objectTypeId, ids });
    revalidate(slug, object);
    return { ok: true };
  } catch (e) {
    return failFrom(e);
  }
}

export async function deleteAttributeAction(
  slug: string,
  object: string,
  attributeId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.attribute.delete({ id: attributeId });
    revalidate(slug, object);
    return { ok: true, message: 'Deleted. Restorable for 24 hours from the list below.' };
  } catch (e) {
    return failFrom(e);
  }
}

export async function restoreAttributeAction(
  slug: string,
  object: string,
  attributeId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  try {
    const client = await api(slug);
    await client.attribute.restore({ id: attributeId });
    revalidate(slug, object);
    return { ok: true, message: 'Restored.' };
  } catch (e) {
    return failFrom(e);
  }
}

export async function setPermissionAction(
  slug: string,
  object: string,
  attributeId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSessionUser();
  const role = text(formData, 'role');
  const access = text(formData, 'access');
  if (!isRole(role)) return fail('Unknown role.');
  const value: AttributeAccess | null = access === 'default' ? null : (access as AttributeAccess);
  if (value !== null && !['HIDDEN', 'READ', 'WRITE'].includes(value))
    return fail('Unknown access level.');
  try {
    const client = await api(slug);
    await client.attribute.setPermission({ attributeId, role, access: value });
    revalidate(slug, object);
    return { ok: true, message: 'Permission saved.' };
  } catch (e) {
    return failFrom(e);
  }
}
