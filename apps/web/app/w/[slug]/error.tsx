'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/error-state';

export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="This screen could not load"
      message="Something went wrong on our side."
      remediation="Try again. If it keeps failing, contact support with the reference below."
      reference={error.digest ?? null}
      onRetry={retry}
    />
  );
}
