import type { ReactNode } from 'react';

/** Pages outside a workspace (home, sign-in, invitations, status) read best at a fixed measure. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-5xl">{children}</div>;
}
