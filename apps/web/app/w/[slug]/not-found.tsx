import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';

export default function WorkspaceNotFound() {
  return (
    <EmptyState
      title="Workspace not found"
      description="Either it does not exist or you are not a member. Ask whoever runs it for an invitation."
      action={
        <LinkButton href="/" variant="primary">
          Your workspaces
        </LinkButton>
      }
    />
  );
}
