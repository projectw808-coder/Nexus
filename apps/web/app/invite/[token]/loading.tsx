import { Skeleton } from '@/components/skeleton';

export default function InviteLoading() {
  return (
    <div
      className="mx-auto flex max-w-lg flex-col gap-6"
      aria-busy="true"
      aria-label="Loading invitation"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-44" />
      <Skeleton className="h-[var(--control-height)] w-48" />
    </div>
  );
}
