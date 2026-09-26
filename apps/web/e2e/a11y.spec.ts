import { test, type Page } from '@playwright/test';
import { assertNoSeriousViolations, signIn } from './helpers';

/**
 * Accessibility gate (§2, §15): axe on every route, failing on serious and critical impact.
 * Routes with dynamic ids are resolved from the seeded data at run time. The connection-detail
 * tabs need a live Mock connection and are checked separately in
 * `settings-integrations.a11y.spec.ts`, which runs after `inbox.spec.ts` (file order matters:
 * this suite runs with one worker, and reconnecting Mock here first would re-trigger a backfill
 * whose extra identity-resolution activity shifts what `inbox.spec.ts`'s "first timeline entry"
 * assertion sees).
 */
async function firstRecordUrl(page: Page): Promise<string> {
  await page.goto('/w/e2e/records/widget');
  const href = await page
    .getByRole('grid')
    .locator('a[href*="/records/widget/"]')
    .first()
    .getAttribute('href');
  if (!href) throw new Error('no record link found');
  return href;
}

async function pipelineUrl(page: Page): Promise<string> {
  await page.goto('/w/e2e/lists');
  const href = await page
    .getByRole('link', { name: 'Sales pipeline' })
    .first()
    .getAttribute('href');
  if (!href) throw new Error('no pipeline link found');
  return href;
}

const STATIC_ROUTES = [
  '/sign-in',
  '/sign-in/check-email?email=a%40b.co',
  '/sign-in/error?error=Verification',
  '/',
  '/new',
  '/w/e2e',
  '/w/e2e/records',
  '/w/e2e/records/widget',
  '/w/e2e/records/widget?q=widget%20000',
  '/w/e2e/records/widget/new',
  '/w/e2e/records/widget/import',
  '/w/e2e/lists',
  '/w/e2e/search?q=deal',
  '/w/e2e/settings/general',
  '/w/e2e/settings/members',
  '/w/e2e/settings/objects',
  '/w/e2e/settings/objects/widget',
  '/w/e2e/settings/audit',
  '/w/e2e/settings/integrations',
  '/w/e2e/settings/canned-replies',
  '/w/e2e/settings/health',
  '/w/e2e/settings/ai',
  '/w/e2e/inbox',
  '/w/e2e/duplicates',
  '/w/e2e/automations',
  '/w/e2e/automations/new',
  '/status',
];

test.describe('axe', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'alice@e2e.test', '/w/e2e');
  });

  for (const route of STATIC_ROUTES) {
    test(`no serious or critical violations on ${route}`, async ({ page }) => {
      await assertNoSeriousViolations(page, route);
    });
  }

  test('no serious or critical violations on a record and a board', async ({ page }) => {
    for (const url of [await firstRecordUrl(page), await pipelineUrl(page)]) {
      await assertNoSeriousViolations(page, url);
    }
  });
});
