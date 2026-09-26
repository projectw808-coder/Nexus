import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The Automations screen (§12.2.G, Phase 10): create a workflow, see it in the list, open it and
 * run a dry run. Does not touch the Mock platform, so file order relative to inbox.spec.ts etc.
 * does not matter (see settings-integrations.a11y.spec.ts for why that matters elsewhere).
 */
test('create a workflow, see it listed, and dry-run it', async ({ page }) => {
  await signIn(page, 'alice@e2e.test', '/w/e2e/automations');
  await page.getByRole('link', { name: 'New workflow' }).first().click();
  await expect(page).toHaveURL(/\/automations\/new$/);

  const name = `E2E workflow ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type', { exact: true }).selectOption('record.created');
  await page.getByLabel('Object type (optional)').fill('widget');
  await page.getByLabel(/^Actions/).fill('[]');
  await page.getByRole('button', { name: 'Create workflow' }).click();

  await expect(page).toHaveURL(/\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name })).toBeVisible();

  await page.goto('/w/e2e/automations');
  await expect(page.getByTestId('workflow-list').getByText(name)).toBeVisible();

  await page.getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Run dry run' }).click();
  await expect(page.getByTestId('dry-run-report')).toBeVisible();
  await expect(page.getByTestId('dry-run-report')).toContainText('Evaluated');
});
