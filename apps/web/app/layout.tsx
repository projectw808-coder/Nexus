import type { Metadata } from 'next';
import { Inter, Noto_Color_Emoji } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, themeInitScript, type Theme } from '@nexus/ui';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
// Country flags only: Windows has no colour flag glyphs, and Google serves this font split by
// unicode-range, so a page downloads just the flag ranges it actually renders.
const emoji = Noto_Color_Emoji({
  weight: '400',
  subsets: ['emoji'],
  variable: '--font-emoji',
  preload: false,
});

export const metadata: Metadata = {
  title: 'Pantera CRM',
  description: 'Multi-channel, API-native CRM with per-platform control.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The cookie lets the server emit the right attribute so there is no flash on first paint,
  // even before the inline script runs or when JavaScript is disabled.
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';
  const htmlProps = theme === 'system' ? {} : { 'data-theme': theme };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      {...htmlProps}
      className={`${inter.variable} ${emoji.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-card focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        {/* Workspace screens draw their own top bar and fill the viewport; app/(site) adds the
            brand header and the reading measure back for everything outside a workspace. */}
        <main id="main" className="w-full">
          {children}
        </main>
      </body>
    </html>
  );
}
