import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, email = 'alice@e2e.test', next = '/w/e2e'): Promise<void> {
  await page.goto(
    `/api/e2e/session?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`,
  );
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
}

/**
 * (Re)connect the mock platform. The app hosts the mock in memory, so a connection left over
 * from an earlier run holds a token this server never issued; connecting again re-issues it.
 * Returns the connection's detail URL (`.../settings/integrations/<id>/overview`).
 */
export async function ensureMockConnected(page: Page): Promise<string> {
  await signIn(page, 'alice@e2e.test', '/w/e2e/settings/integrations');
  await page.getByRole('link', { name: 'Connect Mock' }).click();
  // start → mock authorize → callback → back to integrations with the connection listed.
  await expect(page).toHaveURL(/settings\/integrations\?connected=/, { timeout: 30_000 });
  await expect(page.getByTestId('connect-ok')).toBeVisible();
  const row = page.getByTestId('connection-row').filter({ hasText: 'Mock' });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  const href = await row.getByRole('link').first().getAttribute('href');
  if (!href) throw new Error('connected, but no connection detail link was found');
  return href;
}

/** Axe on one URL, failing only on serious/critical impact (§2, §15). */
export async function assertNoSeriousViolations(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
    url,
  ).toEqual([]);
}
