'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/error-state';

export default function InviteError({
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
    <div className="mx-auto max-w-lg">
      <ErrorState
        title="The invitation could not be loaded"
        message="Something went wrong on our side."
        remediation="Try again in a moment. The link itself is still valid."
        reference={error.digest ?? null}
        onRetry={retry}
      />
    </div>
  );
}
