// Full-suite coverage for the Dashboard tab (src/components/Dashboard/*) and
// the Stats tab (src/components/Stats/*). Uses the seeded mock data
// (src/services/mockData.js) already present in the running app, so "renders
// without errors" assertions rely on that seed data existing (tasks/blocks/
// events today and this week) rather than creating fixtures per-test.
import { test } from '@playwright/test';
import { trackConsoleErrors, gotoApp, gotoTab, expectNoErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await gotoTab(page, 'Dashboard');
});

test('customize menu toggles a widget on/off the dashboard', async ({ page }) => {
  const errors = trackConsoleErrors(page);

  // Notes widget starts visible per DEFAULT_DASHBOARD_WIDGETS.
  await test.step('widget visible by default', async () => {
    await page.locator('.notes-card').getByRole('heading', { name: 'Notes', exact: true }).waitFor({ state: 'visible' });
  });

  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  await menu.getByText('Notes', { exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await test.step('widget hidden after toggling off', async () => {
    const count = await page.locator('.notes-card').count();
    if (count !== 0) throw new Error(`Expected notes-card to be gone after toggling off, found ${count}`);
  });

  // Toggle back on so we leave the (persisted, localStorage-backed) widget
  // preference the way we found it for any other test/session.
  await page.getByRole('button', { name: 'Customize dashboard' }).click();
  await menu.waitFor({ state: 'visible' });
  await menu.getByText('Notes', { exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await test.step('widget visible again after toggling back on', async () => {
    await page.locator('.notes-card').getByRole('heading', { name: 'Notes', exact: true }).waitFor({ state: 'visible' });
  });

  expectNoErrors(errors);
});

test('notes card: add a note, edit it, and it persists after reload', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const title = `E2E note ${Date.now()}`;
  const editedTitle = `${title} edited`;

  await page.locator('.notes-card').getByRole('button', { name: 'Add note' }).click();
  await page.locator('.note-add-form input[placeholder="Title"]').fill(title);
  await page.locator('.note-add-form').getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(300);

  const tile = page.locator('.note-tile', { hasText: title });
  await tile.waitFor({ state: 'visible' });

  // Edit it.
  await tile.getByRole('button', { name: `Edit "${title}"` }).click();
  const editForm = page.locator('.note-edit-form');
  await editForm.locator('input.note-edit-title').fill(editedTitle);
  await editForm.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);

  await page.locator('.note-tile', { hasText: editedTitle }).waitFor({ state: 'visible' });

  // Persistence: reload the app and confirm the edited note is still there.
  await gotoApp(page);
  await gotoTab(page, 'Dashboard');
  await page.locator('.note-tile', { hasText: editedTitle }).waitFor({ state: 'visible' });

  // Clean up so repeated runs don't accumulate notes.
  const persistedTile = page.locator('.note-tile', { hasText: editedTitle });
  await persistedTile.getByRole('button', { name: 'Remove' }).click();
  await page.waitForTimeout(200);

  expectNoErrors(errors);
});

test('now/next card renders with seeded task/event data', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const card = page.locator('.now-next-card');
  await card.waitFor({ state: 'visible' });
  // Either "Right now" content or the empty-gap message should be present —
  // both are valid depending on whether a block covers this exact moment.
  const hasCurrent = await card.locator('.now-block').isVisible().catch(() => false);
  const hasEmpty = await card.locator('.now-empty').isVisible().catch(() => false);
  if (!hasCurrent && !hasEmpty) throw new Error('Now/Next card showed neither a current block nor the empty state');
  expectNoErrors(errors);
});

test('now/next card: clicking the current or next item opens its detail modal', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const card = page.locator('.now-next-card');
  await card.waitFor({ state: 'visible' });

  // "Right now" item, if present, should open a detail modal on click.
  const currentBlock = card.locator('.now-block');
  if (await currentBlock.isVisible({ timeout: 1000 }).catch(() => false)) {
    await currentBlock.click();
    await page.waitForTimeout(300);
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // "Next" item, if present, should also open a detail modal on click.
  const nextBlock = card.locator('.next-block');
  if (await nextBlock.isVisible({ timeout: 1000 }).catch(() => false)) {
    await nextBlock.click();
    await page.waitForTimeout(300);
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  expectNoErrors(errors);
});

test('progress rings render for today and this week', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const row = page.locator('.progress-ring-row');
  await row.waitFor({ state: 'visible' });

  await row.locator('.progress-ring-card', { hasText: "Today's progress" }).waitFor({ state: 'visible' });
  await row.locator('.progress-ring-card', { hasText: "This week's progress" }).waitFor({ state: 'visible' });

  expectNoErrors(errors);
});

test('today agenda lists scheduled items for today', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const agenda = page.locator('.today-agenda');
  await agenda.waitFor({ state: 'visible' });

  const hasItems = await agenda.locator('.today-agenda-list li').first().isVisible().catch(() => false);
  const hasEmpty = await agenda.locator('.now-empty').isVisible().catch(() => false);
  if (!hasItems && !hasEmpty) throw new Error('Today agenda showed neither items nor the empty state');

  // Opening an item (if any) should open a detail modal without erroring.
  const firstOpenable = agenda.locator('.today-agenda-item.is-openable').first();
  if (await firstOpenable.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstOpenable.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  expectNoErrors(errors);
});

test('dashboard stats summary renders and opens detail popups', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const strip = page.locator('.dashboard-stats-strip');
  await strip.waitFor({ state: 'visible' });

  for (const label of ['Scheduled today', 'Overdue & missed', 'Completed today', 'Scheduled this week']) {
    await strip.getByText(label, { exact: true }).waitFor({ state: 'visible' });
  }

  // Clicking a stat tile (other than "Scheduled this week", which jumps to
  // the Calendar tab instead of opening a popup) opens a StatListModal.
  await strip.locator('.dashboard-stat-tile', { hasText: 'Overdue & missed' }).click();
  await page.waitForTimeout(300);
  const dialog = page.getByRole('dialog', { name: 'Overdue & missed' });
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  expectNoErrors(errors);
});

test('stats tab: charts render without console errors', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Stats');

  await page.getByText('Hours planned per day', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Time by project', { exact: true }).waitFor({ state: 'visible' });

  // Hover over chart elements to exercise the interactive bits (BarChart/
  // PieChart both track hover state) without erroring. No date-range/filter
  // controls exist on this tab (StatsDashboard.jsx uses a fixed 14-day
  // horizon), so there's nothing to switch between here.
  const firstBar = page.locator('.stats-bar-scroll [title]').first();
  if (await firstBar.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstBar.hover();
    await page.waitForTimeout(150);
  }
  const firstSlice = page.locator('.stats-chart-card svg path').first();
  if (await firstSlice.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstSlice.hover();
    await page.waitForTimeout(150);
  }

  expectNoErrors(errors);
});
