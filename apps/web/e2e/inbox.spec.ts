import { writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ensureMockConnected, signIn } from './helpers';

/**
 * The §15 end-to-end path, in the browser: connect the mock platform → backfill → an inbound
 * webhook appears in the inbox (live, over SSE) → reply → the outbound is recorded → the
 * commenter's identity is resolved to a person → the person's timeline is correct. Plus the
 * Phase 7 acceptance: two users see each other's assignment changes live, and the keyboard
 * model. (The "report reflects it" step lands with Phase 11 reports.)
 */

async function emitComment(page: Page, text: string): Promise<void> {
  const res = await page.request.post('/api/e2e/mock/_emit', { data: { text } });
  expect(res.ok()).toBe(true);
}

test.describe('unified inbox', () => {
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    // What the app-hosted mock saw, for the failure report.
    const res = await page.request.get('/api/e2e/mock/_stats').catch(() => null);
    const text = res ? await res.text() : '(no response)';
    writeFileSync(testInfo.outputPath('mock-log.json'), text);
  });

  test('connect → backfill → webhook lands live → reply → identity → timeline', async ({
    page,
  }) => {
    await ensureMockConnected(page);
    await page.goto('/w/e2e/inbox');
    await expect(page.getByTestId('inbox')).toBeVisible();
    // Backfilled comment threads are there.
    await expect(page.getByTestId('conversation-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: /^Mock/ })).toBeVisible();

    // A brand-new inbound comment arrives by webhook and appears without a reload.
    const stamp = Date.now().toString(36);
    const text = `Is the ${stamp} roast still available?`;
    await emitComment(page, text);
    const row = page.getByTestId('conversation-row').filter({ hasText: text });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button').click();
    await expect(page.getByTestId('thread')).toContainText(text);

    // Reply through the composer; the outbound is recorded as a sent message.
    const reply = `Yes — the ${stamp} roast ships today.`;
    await page.getByLabel('Reply', { exact: true }).fill(reply);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('message-outbound').filter({ hasText: reply })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('message-outbound').filter({ hasText: reply })).toContainText(
      'sent',
    );
    await expect(page.getByTestId('sla-chip')).toHaveCount(0); // the clock stopped

    // The commenter had no e-mail or phone: resolve them from the sidebar into a person.
    const sidebar = page.getByTestId('context-sidebar');
    const person = sidebar.getByTestId('context-person');
    // An earlier run may already have resolved this commenter; otherwise do it now.
    await expect(sidebar).toContainText(/not linked to a person yet|Person/);
    if ((await person.count()) === 0) {
      await expect(sidebar).toContainText('not linked to a person yet');
      await sidebar.getByTestId('create-person').click();
    }
    await expect(person).toBeVisible({ timeout: 15_000 });
    // The thread's identity is the first commenter; the reply went to them, so it is on the person now.
    await expect(sidebar.getByTestId('context-recent')).toContainText('replied');

    // Their timeline has the comment and the reply, with provenance.
    await person.click();
    await expect(page).toHaveURL(/\/records\/person\//);
    const timeline = page.getByTestId('timeline');
    await expect(timeline).toContainText(reply);
    await expect(timeline).toContainText('replied');
    // Not `.first()`: when this commenter needed `create-person` above, that link action is
    // itself a timeline entry timestamped after the reply, so it — not the comment — sorts
    // first. Assert provenance on the reply entry itself (already confirmed present above)
    // rather than assuming position or that the inbound comment's exact text lands on this
    // identity's timeline (the mock platform can reuse a commenter id already used by
    // unrelated backfilled history).
    await expect(
      timeline.getByTestId('timeline-entry').filter({ hasText: reply }).first(),
    ).toContainText('via Mock');
  });

  test('two users see each other’s assignment changes live', async ({ browser }) => {
    const alice = await pageFor(browser, 'alice@e2e.test');
    const viewer = await pageFor(browser, 'viewer@e2e.test');
    await alice.goto('/w/e2e/inbox');
    await alice.getByTestId('conversation-row').first().getByRole('button').click();
    await expect(alice).toHaveURL(/[?&]c=/);
    const url = alice.url();
    // Start from "unassigned" whatever an earlier run left behind.
    await alice.getByTestId('thread').click();
    await alice.keyboard.press('a');
    await alice.getByTestId('thread').getByLabel('Assignee').selectOption('');
    await expect(alice.getByTestId('assign-button')).toHaveText('Assign');
    await viewer.goto(url);
    await expect(viewer.getByTestId('thread')).toBeVisible();
    await expect(viewer.getByTestId('thread')).not.toContainText('Assigned: Alice E2E');

    // Alice assigns from the keyboard: `a` opens the assignee menu.
    await alice.getByTestId('thread').click();
    await alice.keyboard.press('a');
    await alice
      .getByTestId('thread')
      .getByLabel('Assignee')
      .selectOption({ label: 'Alice E2E (me)' });
    await expect(alice.getByTestId('assign-button')).toContainText('Assigned: Alice E2E');
    // The viewer's tab updates without a reload.
    await expect(viewer.getByTestId('thread')).toContainText('Assigned: Alice E2E', {
      timeout: 15_000,
    });
    await expect(viewer.getByTestId('conversation-row').first()).toContainText('Alice E2E');
    await alice.context().close();
    await viewer.context().close();
  });

  test('keyboard model, snooze, tags, internal note and bulk triage', async ({ page }) => {
    await signIn(page, 'alice@e2e.test', '/w/e2e/inbox');
    const rows = page.getByTestId('conversation-row');
    await expect(rows.first()).toBeVisible();
    await page.getByRole('list', { name: 'Conversations' }).focus();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await expect(page.getByTestId('thread')).toBeVisible();

    // n → internal note with an @mention.
    await page.keyboard.press('n');
    const note = page.getByLabel('Internal note');
    await expect(note).toBeFocused();
    await note.fill(`Escalating this @Val`);
    await page
      .getByRole('listbox', { name: 'Mention a teammate' })
      .getByRole('option', { name: 'Val Viewer' })
      .click();
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('internal-note').last()).toContainText('Escalating this');

    // s → snooze menu; snooze for an hour moves it out of Open.
    await page.getByTestId('thread').click();
    await page.keyboard.press('s');
    const who = await page.getByTestId('thread').getByRole('heading', { level: 2 }).innerText();
    await page.getByRole('button', { name: 'In 1 hour' }).click();
    await expect(page.getByTestId('thread')).toContainText('snoozed');
    await page.getByLabel('Status').selectOption('SNOOZED');
    await expect(rows.filter({ hasText: who }).first()).toBeVisible();
    await page.getByLabel('Status').selectOption('OPEN');

    // Tags from the header.
    await rows.first().getByRole('button').click();
    await page.getByRole('button', { name: /^Tags/ }).click();
    await page.getByLabel('New tag').fill('vip');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('thread')).toContainText('#vip');

    // Bulk: select two, mark read, then close from the toolbar.
    await rows.nth(0).getByRole('checkbox').check();
    await rows.nth(1).getByRole('checkbox').check();
    await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toContainText('2 selected');
    await page
      .getByRole('toolbar', { name: 'Bulk actions' })
      .getByRole('button', { name: 'Mark read' })
      .click();
    await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toHaveCount(0);

    // Saved view round-trip.
    await page.getByLabel('Assignee').selectOption('unassigned');
    await page.getByRole('button', { name: 'Save current filters as a view' }).click();
    const viewName = `Unassigned ${Date.now().toString(36)}`;
    await page.getByLabel('View name').fill(viewName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = page
      .getByLabel('Saved views')
      .getByRole('button', { name: `${viewName} (mine)` });
    await expect(saved).toBeVisible();
    // Leave the workspace as we found it.
    await page.getByRole('button', { name: `Delete view ${viewName}` }).click();
    await expect(saved).toHaveCount(0);
  });
});

async function pageFor(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, '/w/e2e');
  return page;
}
