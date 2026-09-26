/**
 * What the widget form needs to offer real choices instead of free text: the workspace's object
 * types with their attributes, and its lists. Loaded once on the server and handed to the client
 * form as plain data.
 */
import type { Api } from '@/lib/api';
import type { FormList, FormObject } from './widget-form';

export async function formOptions(client: Api): Promise<{
  objects: FormObject[];
  lists: FormList[];
}> {
  const [types, lists] = await Promise.all([client.objectType.list(), client.list.list({})]);
  const objects = await Promise.all(
    types.map(async (t): Promise<FormObject> => {
      const attributes = await client.attribute.list({ objectType: t.apiSlug });
      return {
        apiSlug: t.apiSlug,
        plural: t.plural,
        attributes: attributes.map((a) => ({
          apiSlug: a.apiSlug,
          title: a.title,
          type: a.type,
        })),
      };
    }),
  );
  return {
    objects,
    lists: lists.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
  };
}
