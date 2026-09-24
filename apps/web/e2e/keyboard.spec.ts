import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Every action reachable without a mouse (§12.2.A keyboard model, Phase 3 acceptance). */
test.describe('keyboard-only', () => {
  test('palette, navigation, board move and record panels', async ({ page }) => {
    await signIn(page, 'alice@e2e.test', '/w/e2e');

    // ⌘K → "Widgets" → Enter opens the records table (after the client has hydrated).
    await expect(page.locator('html[data-palette="ready"]')).toBeAttached();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox');
    await expect(box).toBeFocused();
    await box.fill('widgets');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/records\/widget/);

    // Open the first record with Enter on its label cell.
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();
    await grid.locator('[data-cell="0:1"]').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/records\/widget\/[0-9a-f-]+$/);

    // Record shell: tab to the Quantity edit button, edit, save with Enter.
    const edit = page.getByRole('button', { name: 'Edit Quantity' });
    await edit.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('spinbutton').fill('7');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit Quantity' })).toContainText('7');

    // Add a note and a task from the keyboard.
    // Unique per run: the e2e database is reused between runs.
    const stamp = Date.now().toString(36);
    await page.getByLabel('New note').fill(`Called them, follow up Monday ${stamp}`);
    await page.keyboard.press('Control+Enter');
    await expect(
      page.getByRole('paragraph').filter({ hasText: `follow up Monday ${stamp}` }),
    ).toBeVisible();
    await page.getByLabel('Task', { exact: true }).fill(`Send proposal ${stamp}`);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('region', { name: /^Tasks/ }).getByText(`Send proposal ${stamp}`),
    ).toBeVisible();

    // Board: move a card to another stage via its Move menu.
    await page.goto('/w/e2e/lists');
    await page.getByRole('link', { name: 'Sales pipeline' }).first().click();
    const move = page.getByRole('button', { name: 'Move Deal 1' });
    await move.focus();
    await page.keyboard.press('Enter');
    // The e2e database is reused between runs, so take whichever other stage the menu offers.
    const target = page.getByRole('menuitem', { name: /^To / }).first();
    const stage = ((await target.textContent()) ?? '').replace(/^To /, '').trim();
    await target.focus();
    await page.keyboard.press('Enter');
    const column = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: stage }) });
    await expect(column.getByText('Deal 1')).toBeVisible();
  });
});
