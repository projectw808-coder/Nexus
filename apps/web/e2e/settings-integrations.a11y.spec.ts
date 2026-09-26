import { test } from '@playwright/test';
import { assertNoSeriousViolations, ensureMockConnected } from './helpers';

/**
 * The connection-detail tab strip (§12.2.C) needs a live Mock connection, so it is checked here
 * rather than in `a11y.spec.ts`. File name matters: this suite runs single-worker and files run
 * in name order, so this must sort after `inbox.spec.ts` — reconnecting Mock first would
 * re-trigger a backfill whose extra identity-resolution activity shifts what `inbox.spec.ts`'s
 * "first timeline entry" assertion sees.
 */
const CONNECTION_TABS = [
  'overview',
  'data',
  'mapping',
  'permissions',
  'webhooks',
  'activity',
  'danger',
];

test('no serious or critical violations on a connection detail page, any tab', async ({ page }) => {
  const overviewUrl = await ensureMockConnected(page);
  const base = overviewUrl.replace(/\/overview$/, '');
  for (const tab of CONNECTION_TABS) {
    await assertNoSeriousViolations(page, `${base}/${tab}`);
  }
});
