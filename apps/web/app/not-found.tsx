import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';

export default function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="The address may be wrong, or the page may have moved."
      action={
        <LinkButton href="/" variant="primary">
          Back to workspaces
        </LinkButton>
      }
    />
  );
}
