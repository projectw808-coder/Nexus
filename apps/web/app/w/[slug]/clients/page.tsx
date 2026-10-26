import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canWriteRecords } from '@/lib/roles';
import { requireSessionUser } from '@/lib/session';
import { getWorkspace } from '@/lib/workspace';
import { ClientsWorkspace } from './clients-workspace';

export const dynamic = 'force-dynamic';

/** The Clients workspace: KPI cards, the filterable client table and the detail drawer. */
export default async function ClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    client?: string;
    campaign?: string;
    agent?: string;
    status?: string;
    view?: string;
  }>;
}) {
  const [{ slug }, sp, user] = await Promise.all([params, searchParams, requireSessionUser()]);
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let data;
  try {
    data = await client.clientWorkspace.all();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="Clients are hidden from your role"
          description="Reading clients needs a role that can see records."
          currentRole={workspace.role}
          requiredRole="VIEWER"
        />
      );
    }
    throw e;
  }
  const clientParam = sp.client;
  const initialClientId =
    clientParam && data.rows.some((r) => r.id === clientParam) ? clientParam : null;
  const initialFilters = {
    campaign: typeof sp.campaign === 'string' ? sp.campaign : '',
    agent: typeof sp.agent === 'string' ? sp.agent : '',
    status: typeof sp.status === 'string' ? sp.status : '',
    view: typeof sp.view === 'string' ? sp.view : 'all',
  };

  return (
    <ClientsWorkspace
      slug={workspace.slug}
      data={data}
      meId={user.id}
      canWrite={canWriteRecords(workspace.role)}
      initialClientId={initialClientId}
      initialFilters={initialFilters}
    />
  );
}
