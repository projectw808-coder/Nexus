'use client';

import { signOutAction } from '@/app/sign-in/actions';
import { SubmitButton } from '@/components/submit-button';

/** Ends the database session and returns to the sign-in page. */
export function SignOutButton() {
  return (
    <form action={signOutAction} className="inline-block w-auto">
      <SubmitButton variant="secondary" pendingLabel="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  );
}
