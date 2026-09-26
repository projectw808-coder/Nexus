import { PermissionDenied } from '@/components/permission-denied';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { canManage } from '@/lib/roles';
import { getWorkspace } from '@/lib/workspace';
import { ApiKeysView } from './api-keys-view';

export const dynamic = 'force-dynamic';

/**
 * Settings → API keys (§11.2, ADR-022): the credentials external callers authenticate REST v1
 * with. Only owners and admins can see them — `abilities.ts` denies `read` on `ApiKey` to
 * everyone else, so the closed door is shown rather than an empty list.
 */
export default async function ApiKeysPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = await getWorkspace(slug);
  const client = await api(workspace.slug);
  let keys;
  try {
    keys = await client.apiKey.list();
  } catch (e) {
    if (isCode(e, 'FORBIDDEN')) {
      return (
        <PermissionDenied
          title="API keys are hidden from your role"
          currentRole={workspace.role}
          requiredRole="ADMIN"
        />
      );
    }
    throw e;
  }
  return <ApiKeysView initial={keys} canManage={canManage(workspace.role)} />;
}
