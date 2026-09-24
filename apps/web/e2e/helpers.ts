import type { Page } from '@playwright/test';

export async function signIn(page: Page, email = 'alice@e2e.test', next = '/w/e2e'): Promise<void> {
  await page.goto(
    `/api/e2e/session?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`,
  );
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
}
