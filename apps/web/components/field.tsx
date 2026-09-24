import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export const CONTROL_CLASS =
  'h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-hairline bg-raised px-3 text-[var(--text-base)] text-ink ' +
  'placeholder:text-ink-muted hover:border-strong disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-invalid:border-critical';

/**
 * Label + control + hint/error, wired with `aria-describedby` and `aria-invalid`. Children
 * receive nothing implicitly — pass `id={id}` and `aria-describedby={describedBy(id, …)}`
 * yourself, or use the `Input` / `Select` helpers below which do it for you.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className = '',
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[var(--text-sm)] font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="flex items-start gap-1.5 text-[var(--text-sm)] text-critical"
        >
          <span aria-hidden className="font-semibold">
            !
          </span>
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[var(--text-sm)] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(
  id: string,
  opts: { hint?: boolean; error?: boolean },
): string | undefined {
  const ids = [
    opts.error ? `${id}-error` : null,
    opts.hint && !opts.error ? `${id}-hint` : null,
  ].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export function Input({
  id,
  error,
  hint,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { id: string; error?: string | null; hint?: boolean }) {
  return (
    <input
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, { hint: !!hint, error: !!error })}
      className={`${CONTROL_CLASS} ${className}`}
      {...rest}
    />
  );
}

export function Select({
  id,
  error,
  hint,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  id: string;
  error?: string | null;
  hint?: boolean;
}) {
  return (
    <select
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, { hint: !!hint, error: !!error })}
      className={`${CONTROL_CLASS} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
