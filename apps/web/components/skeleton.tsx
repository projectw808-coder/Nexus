/** Loading placeholder: a hairline box with the card surface, no shimmer (§12.3 quiet). */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-[var(--radius-control)] border border-hairline bg-card motion-reduce:animate-none ${className}`}
    />
  );
}

export function TableSkeleton({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-[var(--radius-card)] border border-hairline bg-card"
    >
      <div className="flex gap-4 border-b border-hairline px-3 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1 border-0" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-hairline px-3 py-3 last:border-b-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1 border-0" />
          ))}
        </div>
      ))}
    </div>
  );
}
