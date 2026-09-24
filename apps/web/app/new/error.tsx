'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/error-state';

export default function NewWorkspaceError({
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
      title="The form could not load"
      message="Something went wrong on our side."
      reference={error.digest ?? null}
      onRetry={retry}
    />
  );
}
