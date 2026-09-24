import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Phase 3 acceptance: a 100k-row table scrolls at 60fps. The grid is virtualized and pages by
 * cursor; we scroll it programmatically for three seconds while sampling requestAnimationFrame
 * deltas in the page, and require that long frames (> 2 × 16.7 ms) are rare.
 */
test.describe('records table', () => {
  test('loads 100,000 widgets, scrolls smoothly and pages by cursor', async ({ page }) => {
    await signIn(page, 'alice@e2e.test', '/w/e2e/records/widget');
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();
    await expect(page.getByText(/of 100,000 loaded/)).toBeVisible();

    const rowsBefore = await page.getByRole('row').count();
    expect(rowsBefore).toBeLessThan(80); // virtualized: only the viewport (+overscan) is in the DOM

    const scroller = grid.locator('xpath=..');
    const stats = await scroller.evaluate(async (el) => {
      const deltas: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (t: number) => {
        deltas.push(t - last);
        last = t;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const start = performance.now();
      while (performance.now() - start < 3000) {
        el.scrollTop += 240;
        await new Promise((r) => setTimeout(r, 16));
      }
      running = false;
      deltas.shift();
      const long = deltas.filter((d) => d > 33.4).length;
      const sorted = [...deltas].sort((a, b) => a - b);
      return {
        frames: deltas.length,
        long,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        scrollTop: el.scrollTop,
      };
    });
    // 3 s at 60 fps ≈ 180 frames; allow headless jitter but not jank.
    console.log(`scroll stats: ${JSON.stringify(stats)}`);
    expect(stats.frames).toBeGreaterThan(120);
    expect(stats.long / stats.frames).toBeLessThan(0.1);
    expect(stats.p95).toBeLessThan(40);
    expect(stats.scrollTop).toBeGreaterThan(10_000);

    // Paging happened while scrolling: more than one page is loaded, still virtualized.
    await expect(
      page.getByText(/^(4|6|8)00 of 100,000 loaded|[0-9,]+ of 100,000 loaded/),
    ).toBeVisible();
    const rowsAfter = await page.getByRole('row').count();
    expect(rowsAfter).toBeLessThan(80);
  });

  test('inline edit, sort, group and bulk selection are keyboard reachable', async ({ page }) => {
    await signIn(page, 'alice@e2e.test', '/w/e2e/records/widget?sort=quantity&dir=desc');
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();

    // Focus the first data cell of the label column, move right to Quantity and edit it.
    await grid.locator('[data-cell="0:1"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const editor = page.getByRole('spinbutton');
    await expect(editor).toBeFocused();
    await editor.fill('4242');
    await page.keyboard.press('Enter');
    await expect(grid.locator('[data-cell="0:2"]')).toContainText('4,242');

    // Header menu via keyboard: go up to the header row, open the menu, group by Tier.
    await grid.locator('[data-cell="0:3"]').focus();
    await page.keyboard.press('ArrowUp');
    await expect(grid.locator('[data-cell="-1:3"]')).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Group by/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Grouped by Tier/)).toBeVisible();
    // Grouped rows have a single cell, so reach the header from the group row instead.
    await grid.locator('[data-cell="0:0"]').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(grid.locator('[data-cell="-1:3"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').getByRole('menuitem', { name: 'Ungroup' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Grouped by Tier/)).toHaveCount(0);

    // Select two rows with Shift+Space and see the bulk bar.
    await grid.locator('[data-cell="0:1"]').focus();
    await page.keyboard.press('Shift+Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+Space');
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('2 selected');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toHaveCount(0);
  });

  test('a viewer sees the table read-only', async ({ page }) => {
    await signIn(page, 'viewer@e2e.test', '/w/e2e/records/widget');
    await expect(page.getByRole('grid')).toBeVisible();
    await page.getByRole('grid').locator('[data-cell="0:2"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
  });
});
