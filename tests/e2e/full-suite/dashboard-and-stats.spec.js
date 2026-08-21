// Full-suite coverage for the Dashboard tab (src/components/Dashboard/*) and
// the Stats tab (src/components/Stats/*). Uses the seeded mock data
// (src/services/mockData.js) already present in the running app, so "renders
// without errors" assertions rely on that seed data existing (tasks/blocks/
// events today and this week) rather than creating fixtures per-test.
import { test, expect } from '@playwright/test';
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

test('notes card: add a note via NoteEditorModal, edit it (autosave), and it persists after reload', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const title = `E2E note ${Date.now()}`;
  const editedTitle = `${title} edited`;

  // Create — NoteEditorModal in create mode requires the explicit "Add"
  // (an abandoned create shouldn't leave a junk note, same rule
  // EventDetailModal follows for a new event).
  await page.locator('.notes-card').getByRole('button', { name: 'Add note' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add note' });
  await addDialog.getByPlaceholder('Title').fill(title);
  await addDialog.locator('.note-editor-content [contenteditable="true"]').click();
  await page.keyboard.type('some body text');
  await addDialog.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(300);

  const tile = page.locator('.note-tile', { hasText: title });
  await tile.waitFor({ state: 'visible' });

  // Edit — clicking the tile itself opens the editor directly (no separate
  // hover-only Edit button); an existing note autosaves (debounced) rather
  // than needing an explicit Save.
  await tile.click();
  const editDialog = page.getByRole('dialog', { name: 'Edit note' });
  await editDialog.getByPlaceholder('Title').fill(editedTitle);
  await page.waitForTimeout(700); // let the debounced autosave fire
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.locator('.note-tile', { hasText: editedTitle }).waitFor({ state: 'visible' });

  // Persistence: reload the app and confirm the edited note is still there.
  await gotoApp(page);
  await gotoTab(page, 'Dashboard');
  await page.locator('.note-tile', { hasText: editedTitle }).waitFor({ state: 'visible' });

  // Clean up via the "⋯" menu's Delete (moved off the tile's own hover
  // buttons) so repeated runs don't accumulate notes.
  await page.locator('.note-tile', { hasText: editedTitle }).click();
  await page.getByRole('button', { name: 'Note actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForTimeout(200);
  await expect(page.locator('.note-tile', { hasText: editedTitle })).toHaveCount(0);

  expectNoErrors(errors);
});

test('notes card: search is fuzzy (typo-tolerant), and Cancel on a new note creates nothing', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const title = `E2eFuzzySearchNote${Date.now()}`;

  await page.locator('.notes-card').getByRole('button', { name: 'Add note' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add note' });
  await addDialog.getByPlaceholder('Title').fill(title);
  await addDialog.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator('.note-tile', { hasText: title }).waitFor({ state: 'visible' });

  // Dropping the trailing digit is a one-edit-distance typo — should still
  // surface it via the shared nameSearch.js ranker's fuzzy tier, same as
  // the Manage Projects modal's own typo-tolerant search test.
  await page.locator('.notes-search-input').fill(title.slice(0, -1));
  await page.waitForTimeout(200);
  await expect(page.locator('.note-tile', { hasText: title })).toBeVisible();
  await page.locator('.notes-search-clear').click();

  // Opening "Add note" and dismissing without clicking "Add" creates nothing.
  await page.locator('.notes-card').getByRole('button', { name: 'Add note' }).click();
  const secondDialog = page.getByRole('dialog', { name: 'Add note' });
  await secondDialog.getByPlaceholder('Title').fill('Should not be created');
  await secondDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('.note-tile', { hasText: 'Should not be created' })).toHaveCount(0);

  // Clean up.
  await page.locator('.note-tile', { hasText: title }).click();
  await page.getByRole('button', { name: 'Note actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
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
  const strip = page.locator('.progress-rings-strip');
  await strip.waitFor({ state: 'visible' });

  await strip.locator('.progress-ring-mini', { hasText: 'Today' }).waitFor({ state: 'visible' });
  await strip.locator('.progress-ring-mini', { hasText: 'This week' }).waitFor({ state: 'visible' });

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

test('notes: saving a note with no title explains why instead of doing nothing', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  await page.getByRole('button', { name: /Add note/i }).first().click();
  await page.getByPlaceholder('Title').waitFor();

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.field-rejection-hint')).toContainText('title');
  // Still open — the rejected save didn't close the editor.
  await expect(page.locator('.modal-note-editor')).toBeVisible();

  // The first keystroke dismisses the hint rather than leaving it stale.
  await page.getByPlaceholder('Title').fill('Titled after all');
  await expect(page.locator('.field-rejection-hint')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.modal-note-editor')).toHaveCount(0);
  await expect(page.locator('.note-tile-title', { hasText: 'Titled after all' })).toBeVisible();

  expectNoErrors(errors);
});

test('notes: "Export as Markdown" downloads the note as a .md file', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  await page.getByRole('button', { name: /Add note/i }).first().click();
  await page.getByPlaceholder('Title').fill('Export me');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await page.locator('.note-tile-clickable', { hasText: 'Export me' }).first().click();
  await page.locator('.note-editor-content .tiptap').click();
  await page.keyboard.type('body text');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.locator('.modal-note-editor .menu-trigger').first().click();
      await page.getByRole('menuitem', { name: /Export as Markdown/i }).click();
    })(),
  ]);
  expect(download.suggestedFilename()).toBe('Export me.md');

  expectNoErrors(errors);
});
