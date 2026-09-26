import { redirect } from 'next/navigation';

export default async function ConnectionDetailIndex({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  redirect(`/w/${slug}/settings/integrations/${connectionId}/overview`);
}
