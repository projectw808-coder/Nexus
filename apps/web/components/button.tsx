import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-medium ' +
  'transition-colors duration-[var(--duration-state)] ease-[var(--ease-standard)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-ink-inverse hover:opacity-90',
  secondary: 'border border-hairline bg-card text-ink hover:border-strong',
  danger: 'border border-hairline bg-card text-critical hover:border-critical',
  ghost: 'text-ink-secondary hover:bg-raised hover:text-ink',
};

const SIZE: Record<ButtonSize, string> = {
  md: 'h-[var(--control-height)] px-3 text-[var(--text-sm)]',
  sm: 'h-7 px-2 text-[var(--text-xs)]',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return [BASE, VARIANT[variant], SIZE[size], extra].filter(Boolean).join(' ');
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}
