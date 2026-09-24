import { Skeleton, TableSkeleton } from '@/components/skeleton';

export default function RecordsTableLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-40" />
      </div>
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}
