import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, type Theme } from '@nexus/ui';
import { BrandMark } from '@/components/brand-mark';
import { ThemeToggle } from '@/components/theme-toggle';

/** Pages outside a workspace (home, sign-in, invitations, status) read best at a fixed measure. */
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';
  return (
    <>
      <header className="flex h-14 items-center justify-between border-b border-hairline bg-card px-4">
        <BrandMark />
        <ThemeToggle initial={theme} />
      </header>
      <div className="mx-auto w-full max-w-5xl px-4 py-8">{children}</div>
    </>
  );
}
