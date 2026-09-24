'use client';

import { useFormStatus } from 'react-dom';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/button';

/**
 * Submit button that reflects the enclosing form's pending state. Stands in for the auth
 * agent's `SubmitButton` under a different name so the two never collide.
 */
export function FormSubmit({
  children,
  pendingText,
  variant = 'primary',
  size = 'md',
  className = '',
  disabled,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClass(variant, size, className)}
    >
      {pending ? (pendingText ?? children) : children}
    </button>
  );
}
