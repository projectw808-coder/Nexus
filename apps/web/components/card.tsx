import type { HTMLAttributes } from 'react';

/** The shared card surface (§12.2.C connection grid, health console, etc). */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-hairline bg-card ${className}`}
      {...rest}
    />
  );
}
