'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

type Variant = 'primary' | 'secondary';

const BASE =
  'inline-flex h-[var(--control-height)] w-full items-center justify-center rounded-[var(--radius-control)] px-3 text-[var(--text-sm)] font-medium transition-opacity duration-[var(--duration-state)] disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-ink-inverse',
  secondary: 'border border-hairline bg-card text-ink hover:bg-raised',
};

/**
 * A form submit button that shows its pending state while the enclosing form's server action
 * runs (§0.8: loading state is designed, not implied). Must sit inside a `<form>`.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel: string;
  variant?: Variant;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-busy={pending}
      className={`${BASE} ${VARIANT[variant]}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
