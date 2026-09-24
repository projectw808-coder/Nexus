import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

/**
 * Semantic table with the density tokens (row height, cell padding). Columns are plain
 * `<Th>`/`<Td>`; pass a visually-hidden `caption` so screen readers know what the table is.
 */
export function DataTable({
  caption,
  head,
  children,
  className = '',
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-x-auto rounded-[var(--radius-card)] border border-hairline bg-card ${className}`}
    >
      <table className="w-full border-collapse text-[var(--text-sm)]">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-hairline text-left text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-hairline)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  className = '',
  align,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={[
        'h-[var(--row-height)] px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] font-medium',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      ].join(' ')}
      {...rest}
    />
  );
}

export function Td({
  className = '',
  align,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={[
        'h-[var(--row-height)] px-[var(--cell-padding-x)] py-[var(--cell-padding-y)] align-middle',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      ].join(' ')}
      {...rest}
    />
  );
}
