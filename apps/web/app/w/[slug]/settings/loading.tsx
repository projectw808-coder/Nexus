import { Skeleton, TableSkeleton } from '@/components/skeleton';

export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-32" />
      <TableSkeleton />
    </div>
  );
}
