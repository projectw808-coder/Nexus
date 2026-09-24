'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/error-state';

export default function RootError({
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
      message="Something went wrong on our side."
      remediation="We have been notified. If this persists, contact support with the reference below."
      reference={error.digest ?? null}
      onRetry={retry}
    />
  );
}
