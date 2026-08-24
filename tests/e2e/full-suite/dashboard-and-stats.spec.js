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

test('notes: dismissing a half-written new note is refused, but Cancel still discards it', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  await page.getByRole('button', { name: /Add note/i }).first().click();
  await page.getByPlaceholder('Title').waitFor();
  await page.locator('.note-editor-content .tiptap').click();
  await page.keyboard.type('work in progress');

  // Escape and the X are casual dismissals — they used to throw the body away
  // without a word, which read as the app losing work.
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-note-editor')).toBeVisible();
  await expect(page.locator('.field-rejection-hint')).toContainText('title');

  await page.locator('.modal-note-editor .detail-header-close').click();
  await expect(page.locator('.modal-note-editor')).toBeVisible();

  // Cancel is an explicit choice, so it discards without argument.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.modal-note-editor')).toHaveCount(0);
  await expect(page.locator('.note-tile-title', { hasText: 'work in progress' })).toHaveCount(0);

  expectNoErrors(errors);
});

test('notes: an untitled, empty new note closes freely — nothing to lose', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  await page.getByRole('button', { name: /Add note/i }).first().click();
  await page.getByPlaceholder('Title').waitFor();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-note-editor')).toHaveCount(0);

  expectNoErrors(errors);
});

test('Stats: estimate accuracy explains itself when empty, and reports with a sample size once there is data', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoApp(page);
  await gotoTab(page, 'Stats');

  /* Seeded data has no timer-tracked completions, so the panel must say what
     to do rather than render a meaningless 0 or a bare ratio. actualHours is
     only ever set by completing a task with a running timer. */
  await expect(page.locator('.stats-accuracy-empty')).toBeVisible();
  await expect(page.locator('.stats-accuracy-verdict')).toHaveCount(0);

  await page.addInitScript(([prefix]) => {
    const existing = JSON.parse(localStorage.getItem(prefix + 'tasks') || '[]');
    const projectId = existing.find((t) => t.projectId)?.projectId || null;
    const timed = [1, 2, 3, 4, 5, 6].map((i) => ({
      id: `e2e-acc-${i}`,
      title: `E2E timed task ${i}`,
      estimatedHours: 1,
      actualHours: 2, // consistently double, so the ratio is unambiguous
      projectId,
      priority: 'medium',
      dueDate: '2026-01-01',
      isCompleted: true,
      remainingHours: 0,
      dependsOn: [],
      labelIds: [],
    }));
    localStorage.setItem(prefix + 'tasks', JSON.stringify([...existing, ...timed]));
  }, ['taskflow:v1:']);
  await page.reload();
  await page.waitForTimeout(800);
  await gotoTab(page, 'Stats');

  // 6h estimated vs 12h actual → exactly 2.0x, phrased as a sentence rather
  // than a bare ratio the reader has to interpret.
  await expect(page.locator('.stats-accuracy-verdict')).toHaveText(/2\.0× longer than you estimate/);
  // Sample size is never omitted: a ratio from two tasks looks like one from fifty.
  await expect(page.locator('.stats-accuracy-sample')).toContainText('6 timed tasks');
  await expect(page.locator('.stats-accuracy-detail').first()).toContainText('6.0h estimated, 12.0h actually spent');
  // And it states plainly that it changes nothing on its own.
  await expect(page.locator('.stats-accuracy-card')).toContainText(/nothing here changes your estimates/i);

  expectNoErrors(errors);
});

test('loading skeletons never replace a genuine empty state', async ({ page }) => {
  /* The failure mode worth guarding: a placeholder shown when the app is NOT
     loading spins forever, which is strictly worse than "nothing here yet".
     Signed out there is no loading window at all — local state is read from
     localStorage synchronously — so no surface may ever show one. */
  const errors = trackConsoleErrors(page);
  await gotoApp(page);

  // Populated: no skeletons anywhere.
  await gotoTab(page, 'Tasks');
  await expect(page.locator('.skeleton-list')).toHaveCount(0);
  await gotoTab(page, 'Dashboard');
  await expect(page.locator('.skeleton-list')).toHaveCount(0);

  // Genuinely empty: the honest empty state, still no skeleton.
  await page.evaluate(() => localStorage.setItem('taskflow:v1:tasks', '[]'));
  await page.reload();
  await page.waitForTimeout(900);
  await gotoTab(page, 'Tasks');
  await expect(page.locator('.skeleton-list')).toHaveCount(0);
  await expect(page.locator('.tasklist-rows')).toContainText(/no tasks/i);

  expectNoErrors(errors);
});

test.describe('Weekly review', () => {
  /** A realistic week: finished work, slips, old debt, and something due next week. */
  async function seedWeek(page) {
    await page.evaluate(() => {
      // LOCAL date, not toISOString(): the app derives "today" from the local
      // clock (toISODate), so a UTC-based seed is a day off for any positive
      // UTC offset — at UTC+12 every "due today" task seeds as due yesterday.
      const iso = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const base = {
        isCompleted: false, isLocked: false, estimatedHours: 2, remainingHours: 2, priority: 'medium',
        dependsOn: [], minChunkHours: 0.5, maxChunkHours: 4, source: 'manual', projectId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify([
        { ...base, id: 'wr_done', title: 'WR finished thing', isCompleted: true, completedAt: new Date(Date.now() - 2 * 86400000).toISOString(), actualHours: 3 },
        { ...base, id: 'wr_slip', title: 'WR slipped thing', dueDate: iso(-3) },
        { ...base, id: 'wr_old', title: 'WR ancient debt', dueDate: iso(-40), postponeCount: 4 },
        { ...base, id: 'wr_next', title: 'WR due next week', dueDate: iso(3), remainingHours: 6 },
      ]));
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify([]));
      localStorage.removeItem('taskflow:v1:lastWeeklyReviewAt');
    });
    await page.reload();
    await page.waitForTimeout(700);
  }

  test('the dashboard nudge opens a review with three non-overlapping buckets and a capacity verdict', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await seedWeek(page);
    await gotoTab(page, 'Dashboard');

    // The nudge states the counts, because those are the reason to open it.
    const card = page.locator('.weekly-review-card');
    // Wording flips to "last week" on the first day of a week (the review
    // then covers the week that just ended), so match either.
    await expect(card).toContainText(/1 slipped (this|last) week/);
    await expect(card).toContainText('1 carried over');
    await card.getByRole('button', { name: 'Review' }).click();
    await page.waitForTimeout(400);

    const dialog = page.getByRole('dialog', { name: 'Weekly review' });
    await expect(dialog).toContainText('1 task done');
    // Each task appears in exactly one bucket.
    const slipped = dialog.locator('.review-section', { has: page.getByText(/Slipped (this|last) week/) });
    await expect(slipped.locator('.review-row-title')).toHaveText(['WR slipped thing']);
    const carried = dialog.locator('.review-section', { has: page.getByText('Carried over') });
    await expect(carried.locator('.review-row-title')).toHaveText(['WR ancient debt']);
    // The task due NEXT week is in neither — it hasn't slipped.
    await expect(dialog.getByText('WR due next week')).toHaveCount(0);
    // The chronically-pushed one is flagged where the decision gets made.
    await expect(carried.locator('.badge.postponed')).toHaveText(/pushed 4/);
    // And the verdict is rendered with a tone class, not just text.
    await expect(dialog.locator('.review-fit')).toHaveClass(/review-fit-(fits|tight|over)/);

    expectNoErrors(errors);
  });

  test('"Next week" moves a task, updates the verdict live, and closing silences the nudge', async ({ page }) => {
    /* The capacity line changing as you act is the whole reason the actions
       live on this screen rather than in the Tasks list. */
    const errors = trackConsoleErrors(page);
    await seedWeek(page);
    await gotoTab(page, 'Dashboard');
    await page.locator('.weekly-review-card').getByRole('button', { name: 'Review' }).click();
    await page.waitForTimeout(400);

    const dialog = page.getByRole('dialog', { name: 'Weekly review' });
    const before = await dialog.locator('.review-fit').textContent();

    await dialog.locator('.review-row').first().getByRole('button', { name: /Next week/ }).click();
    await page.waitForTimeout(700);

    // The moved task left the slipped bucket and its hours joined next week.
    await expect(dialog.locator('.review-section', { has: page.getByText(/Slipped (this|last) week/) }).locator('.review-row')).toHaveCount(0);
    expect(await dialog.locator('.review-fit').textContent()).not.toBe(before);

    const moved = await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'wr_slip'));
    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    expect(moved.dueDate > today).toBe(true);
    // Moving a deadline out IS a postponement, so the counter picks it up.
    expect(moved.postponeCount).toBe(1);

    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForTimeout(600);
    // Closing is what "I did my review" means, so the card goes for a week.
    await expect(page.locator('.weekly-review-card')).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('the review is reachable from the command palette even with no nudge, and says when there is nothing to do', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.evaluate(() => {
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify([]));
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify([]));
    });
    await page.reload();
    await gotoTab(page, 'Dashboard');
    // Nothing to review, so no nudge — a prompt onto an empty screen would
    // teach people to ignore prompts.
    await expect(page.locator('.weekly-review-card')).toHaveCount(0);

    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.getByLabel('Command palette search').fill('weekly');
    await page.waitForTimeout(300);
    await palette.getByRole('option', { name: 'Weekly review' }).click();
    await page.waitForTimeout(400);

    await expect(page.getByRole('dialog', { name: 'Weekly review' })).toContainText(/Nothing finished, slipped or outstanding/);

    expectNoErrors(errors);
  });

  test('a closed review stays reachable from a quiet row under the progress rings', async ({ page }) => {
    /* The prompt going away must not take the review with it — before this,
       a closed review was only reachable from the command palette, which
       nobody discovers. */
    const errors = trackConsoleErrors(page);
    await seedWeek(page);
    await gotoTab(page, 'Dashboard');

    await page.locator('.weekly-review-card').getByRole('button', { name: 'Review' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('dialog', { name: 'Weekly review' }).getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForTimeout(600);

    // Prompt gone, quiet row in its place.
    await expect(page.locator('.weekly-review-card')).toHaveCount(0);
    const reopen = page.locator('.weekly-review-reopen');
    await expect(reopen).toBeVisible();
    await reopen.click();
    await expect(page.getByRole('dialog', { name: 'Weekly review' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // And it's a real touch target at phone width, where it spans the column.
    await page.setViewportSize({ width: 375, height: 720 });
    await page.waitForTimeout(500);
    await reopen.scrollIntoViewIfNeeded();
    const box = await reopen.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)).toBe(true);
    await reopen.click();
    await expect(page.getByRole('dialog', { name: 'Weekly review' })).toBeVisible();

    expectNoErrors(errors);
  });

  test('the first-day-of-week setting moves the review window and the calendar', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoTab(page, 'Settings');
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: 'First day of the week' }).click();
    await page.getByRole('option', { name: 'Monday', exact: true }).click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:rules')).weekStartsOn)).toBe(1);

    // The calendar's week view starts on Monday now.
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(700);
    const labels = await page.locator('.dow').allTextContents();
    if (labels.length === 7) expect(labels[0]).toBe('MON');

    // And back to Sunday, which is the default.
    await gotoTab(page, 'Settings');
    await page.getByRole('button', { name: 'First day of the week' }).click();
    await page.getByRole('option', { name: 'Sunday', exact: true }).click();
    await page.waitForTimeout(400);
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(700);
    const back = await page.locator('.dow').allTextContents();
    if (back.length === 7) expect(back[0]).toBe('SUN');

    expectNoErrors(errors);
  });
});

test('Stats: a "must be done on due date" task is not flagged as missing its buffer', async ({ page }) => {
  /* enforceDueDate collapses the planning window onto the due date, so there
     is no buffer to miss. Stats re-derived the deadline as
     `dueDate - bufferDays` and dropped that carve-out, reporting such a task
     permanently at risk while the scheduler considered it on time. It now uses
     the scheduler's own getEffectiveDeadline, so the two cannot disagree. */
  const errors = trackConsoleErrors(page);
  await page.evaluate(() => {
    const iso = (o) => {
      const x = new Date();
      x.setDate(x.getDate() + o);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const base = {
      isCompleted: false, isLocked: false, estimatedHours: 2, remainingHours: 2, priority: 'medium',
      dependsOn: [], minChunkHours: 0.5, maxChunkHours: 4, source: 'manual', projectId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    localStorage.setItem('taskflow:v1:tasks', JSON.stringify([
      { ...base, id: 'enf', title: 'BUFENF on the day', dueDate: iso(0), enforceDueDate: true },
      { ...base, id: 'ord', title: 'BUFORD ordinary', dueDate: iso(0) },
      { ...base, id: 'fut', title: 'BUFFUT later', dueDate: iso(7) },
    ]));
    localStorage.setItem('taskflow:v1:blocks', JSON.stringify([]));
  });
  await page.reload();
  await gotoTab(page, 'Stats');
  await page.waitForTimeout(900);

  const body = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
  expect(body).not.toContain('BUFENF'); // has no buffer to miss
  expect(body).toContain('BUFORD'); // genuinely past its buffer deadline
  expect(body).not.toContain('BUFFUT'); // plenty of time

  expectNoErrors(errors);
});

/* Seeds one task with TWO scheduled blocks today: an earlier one already
   past its end time (so it starts "Missed" per isBlockMissed) and a later
   one still upcoming. Both are real task blocks (not calendar events), so
   TodayAgenda's canToggleBlockDone should offer a checkbox on each — see
   src/utils/missedTasks.js and SchedulerContext's markBlockDone/
   unmarkBlockDone. Hoisted to module scope (not just "Marking a scheduled
   block done"'s own describe) so the auto-complete tests further down can
   reuse the same two-block fixture. */
async function seedTaskWithTwoBlocksToday(page, { idPrefix = 'e2e_block_done' } = {}) {
  await page.evaluate(([prefix]) => {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    // Earlier block: started an hour ago, ended 30 minutes ago — already
    // missed. Later block: starts in 2 hours — still upcoming, untouched
    // by anything this test does to the earlier one.
    const earlierStart = new Date(now.getTime() - 60 * 60000);
    const earlierEnd = new Date(now.getTime() - 30 * 60000);
    const laterStart = new Date(now.getTime() + 120 * 60000);
    const laterEnd = new Date(now.getTime() + 180 * 60000);
    const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const task = {
      id: `${prefix}_task`,
      title: 'E2E Multi-Block Task',
      isCompleted: false,
      isLocked: false,
      estimatedHours: 4,
      remainingHours: 4,
      priority: 'medium',
      dependsOn: [],
      minChunkHours: 0.5,
      maxChunkHours: 4,
      source: 'manual',
      projectId: null,
      dueDate: todayIso,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const blockEarlier = {
      id: `${prefix}_earlier`,
      taskId: task.id,
      date: todayIso,
      startTime: hm(earlierStart),
      endTime: hm(earlierEnd),
      durationHours: 0.5,
      isLocked: false,
      isAutoScheduled: false,
      status: 'scheduled',
    };
    const blockLater = {
      id: `${prefix}_later`,
      taskId: task.id,
      date: todayIso,
      startTime: hm(laterStart),
      endTime: hm(laterEnd),
      durationHours: 1,
      isLocked: false,
      isAutoScheduled: false,
      status: 'scheduled',
    };
    const existingTasks = JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]');
    localStorage.setItem('taskflow:v1:tasks', JSON.stringify([...existingTasks, task]));
    const existingBlocks = JSON.parse(localStorage.getItem('taskflow:v1:blocks') || '[]');
    localStorage.setItem('taskflow:v1:blocks', JSON.stringify([...existingBlocks, blockEarlier, blockLater]));
  }, [idPrefix]);
  await page.reload();
  await page.waitForTimeout(700);
}

test.describe('Marking a scheduled block done', () => {
  test('a missed block can be marked done from Today\'s agenda without completing the whole task', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithTwoBlocksToday(page);
    await gotoTab(page, 'Dashboard');

    const agenda = page.locator('.today-agenda');
    await agenda.waitFor({ state: 'visible' });
    const missedRow = agenda.locator('.today-agenda-item', { hasText: 'E2E Multi-Block Task' }).first();
    await expect(missedRow).toHaveClass(/is-missed/);
    await expect(missedRow.locator('.today-agenda-missed-label')).toBeVisible();

    // The checkbox is hover-revealed (opacity: 0 at rest, per dashboard.css)
    // but exists in the DOM and is clickable regardless — hover it anyway to
    // exercise the real interaction path.
    await missedRow.hover();
    const checkbox = missedRow.locator('.today-agenda-block-checkbox');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await page.waitForTimeout(400);

    // This row now reads as completed, missed indicator gone.
    await expect(missedRow).not.toHaveClass(/is-missed/);
    await expect(missedRow.locator('.today-agenda-completed-label, .today-agenda-completed-late-label')).toBeVisible();
    await expect(missedRow.locator('.today-agenda-missed-label')).toHaveCount(0);

    // The SECOND (still-upcoming) row for the same task must be untouched —
    // proves this only closed out one block's slice, not the whole task.
    const upcomingRow = agenda.locator('.today-agenda-item', { hasText: 'E2E Multi-Block Task' }).nth(1);
    await expect(upcomingRow).toBeVisible();
    await expect(upcomingRow.locator('.today-agenda-completed-label, .today-agenda-completed-late-label')).toHaveCount(0);
    await expect(upcomingRow.locator('.today-agenda-due-label')).toBeVisible();

    // And the task itself is still not completed.
    const task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_block_done_task')
    );
    expect(task.isCompleted).toBe(false);
    expect(task.remainingHours).toBeCloseTo(3.5, 5); // 4h estimate - 0.5h earlier block

    expectNoErrors(errors);
  });

  test('TaskDetailModal\'s Scheduled section reflects and can reverse a block\'s done state', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithTwoBlocksToday(page, { idPrefix: 'e2e_block_modal' });
    await gotoTab(page, 'Dashboard');

    const agenda = page.locator('.today-agenda');
    await agenda.waitFor({ state: 'visible' });
    const missedRow = agenda.locator('.today-agenda-item', { hasText: 'E2E Multi-Block Task' }).first();
    await missedRow.hover();
    await missedRow.locator('.today-agenda-block-checkbox').click();
    await page.waitForTimeout(400);

    // Open the task's detail modal via search (Tasks tab), same convention
    // as tasks-and-smart-parse.spec.js's searchAndOpen.
    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill('E2E Multi-Block Task');
    await page.waitForTimeout(300);
    await page.getByText('E2E Multi-Block Task', { exact: false }).first().click();
    await page.waitForTimeout(300);

    const scheduledRows = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRows).toHaveCount(2);
    // Sorted oldest-first (date/startTime) — the earlier (now-done) block is
    // first, the later (still-scheduled) block second.
    const doneRow = scheduledRows.nth(0);
    const openRow = scheduledRows.nth(1);
    await expect(doneRow.locator('input[type="checkbox"]')).toBeChecked();
    await expect(openRow.locator('input[type="checkbox"]')).not.toBeChecked();

    // Read "Time left" before un-checking.
    const timeLeftField = page.locator('.detail-field', { hasText: 'Time left' });
    await expect(timeLeftField.locator('.smart-duration-input')).toHaveValue(/3 hours 30 minutes|3\.5/);

    // Un-check the done block — restores exactly what was applied.
    await doneRow.locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);
    await expect(doneRow.locator('input[type="checkbox"]')).not.toBeChecked();
    await expect(timeLeftField.locator('.smart-duration-input')).toHaveValue(/^4 hours$/);

    const blocks = await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:blocks')));
    const restored = blocks.find((b) => b.id === 'e2e_block_modal_earlier');
    expect(restored.status).toBe('scheduled');
    expect(restored.hoursAppliedToRemaining).toBeUndefined();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('the "Overdue & missed" popup\'s own checkbox marks a missed block done and removes it from the list', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithTwoBlocksToday(page, { idPrefix: 'e2e_block_popup' });
    await gotoTab(page, 'Dashboard');

    const strip = page.locator('.dashboard-stats-strip');
    await strip.waitFor({ state: 'visible' });
    await strip.locator('.dashboard-stat-tile', { hasText: 'Overdue & missed' }).click();
    await page.waitForTimeout(300);

    const dialog = page.getByRole('dialog', { name: 'Overdue & missed' });
    await dialog.waitFor({ state: 'visible' });
    const missedItem = dialog.locator('.missed-tasks-item', { hasText: 'E2E Multi-Block Task' });
    await expect(missedItem).toBeVisible();

    await missedItem.hover();
    const checkbox = missedItem.locator('.missed-tasks-block-checkbox');
    await expect(checkbox).toBeVisible();
    await checkbox.click();
    await page.waitForTimeout(400);

    // Disappears from the popup's list entirely (no "checked" state to show
    // — see StatListItem's own comment: it just drops out on the next render).
    await expect(dialog.locator('.missed-tasks-item', { hasText: 'E2E Multi-Block Task' })).toHaveCount(0);

    const blocks = await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:blocks')));
    const marked = blocks.find((b) => b.id === 'e2e_block_popup_earlier');
    expect(marked.status).toBe('done');

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('manually reducing "Time left" by a whole block\'s duration auto-marks it done, and increasing it back un-marks it', async ({ page }) => {
    // Mechanism B: setRemainingHoursWithBlockInference / planBlockCompletionFromRemainingHoursEdit.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithTwoBlocksToday(page, { idPrefix: 'e2e_block_infer' });

    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill('E2E Multi-Block Task');
    await page.waitForTimeout(300);
    await page.getByText('E2E Multi-Block Task', { exact: false }).first().click();
    await page.waitForTimeout(300);

    // Task starts at 4h remaining, with a 0.5h earlier block and a 1h later
    // block (both still 'scheduled'). Reducing Time left by exactly 0.5h
    // (the earlier block's own durationHours) should walk oldest-first and
    // mark that one block done, per planBlockCompletionFromRemainingHoursEdit.
    const timeLeftInput = page.locator('.detail-field', { hasText: 'Time left' }).locator('.smart-duration-input');
    await timeLeftInput.click();
    await timeLeftInput.fill('3.5h');
    await timeLeftInput.blur();
    await page.waitForTimeout(400);

    const scheduledRows = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRows).toHaveCount(2);
    await expect(scheduledRows.nth(0).locator('input[type="checkbox"]')).toBeChecked();
    await expect(scheduledRows.nth(1).locator('input[type="checkbox"]')).not.toBeChecked();

    // Persisted: re-open the modal from scratch and confirm it stuck.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await search.fill('');
    await search.fill('E2E Multi-Block Task');
    await page.waitForTimeout(300);
    await page.getByText('E2E Multi-Block Task', { exact: false }).first().click();
    await page.waitForTimeout(300);
    const scheduledRowsReopened = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRowsReopened.nth(0).locator('input[type="checkbox"]')).toBeChecked();

    // Now increase Time left back by the same amount — un-marks the block
    // (newest-done-first, per the function's un-mark branch; only one block
    // is done here so it's unambiguous which one).
    const timeLeftInput2 = page.locator('.detail-field', { hasText: 'Time left' }).locator('.smart-duration-input');
    await timeLeftInput2.click();
    await timeLeftInput2.fill('4h');
    await timeLeftInput2.blur();
    await page.waitForTimeout(400);
    await expect(scheduledRowsReopened.nth(0).locator('input[type="checkbox"]')).not.toBeChecked();

    const blocks = await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:blocks')));
    const earlier = blocks.find((b) => b.id === 'e2e_block_infer_earlier');
    expect(earlier.status).toBe('scheduled');
    expect(earlier.hoursAppliedToRemaining).toBeUndefined();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });
});

test.describe('Auto-completing a task when its scheduled work is fully accounted for', () => {
  /* Seeds one task with exactly ONE scheduled block today, already past its
     end time (mirrors seedTaskWithTwoBlocksToday's "earlier" block above, but
     alone rather than paired with a still-upcoming one) — marking it done
     should reduce remaining hours straight to 0 and trigger auto-complete. */
  async function seedTaskWithOneBlockToday(page, { idPrefix = 'e2e_auto_complete', estimatedHours = 1 } = {}) {
    await page.evaluate(([prefix, hours]) => {
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const start = new Date(now.getTime() - 60 * 60000);
      const end = new Date(now.getTime() - 5 * 60000);
      const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

      const task = {
        id: `${prefix}_task`,
        title: 'E2E Auto Complete Task',
        isCompleted: false,
        isLocked: false,
        estimatedHours: hours,
        remainingHours: hours,
        priority: 'medium',
        dependsOn: [],
        minChunkHours: 0.5,
        maxChunkHours: 4,
        source: 'manual',
        projectId: null,
        dueDate: todayIso,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const block = {
        id: `${prefix}_block`,
        taskId: task.id,
        date: todayIso,
        startTime: hm(start),
        endTime: hm(end),
        durationHours: hours,
        isLocked: false,
        isAutoScheduled: false,
        status: 'scheduled',
      };
      const existingTasks = JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]');
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify([...existingTasks, task]));
      const existingBlocks = JSON.parse(localStorage.getItem('taskflow:v1:blocks') || '[]');
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify([...existingBlocks, block]));
    }, [idPrefix, estimatedHours]);
    await page.reload();
    await page.waitForTimeout(700);
  }

  async function openTaskDetail(page, title) {
    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill('');
    await search.fill(title);
    await page.waitForTimeout(300);
    await page.getByText(title, { exact: false }).first().click();
    await page.waitForTimeout(300);
  }

  test('marking a task\'s only scheduled block done auto-completes the whole task', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithOneBlockToday(page);
    await openTaskDetail(page, 'E2E Auto Complete Task');

    const scheduledRows = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRows).toHaveCount(1);
    await scheduledRows.first().locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);

    // completeTask closes out the whole task, so the title-row checkbox now
    // shows as checked/completed.
    const titleCheckbox = page.getByRole('dialog', { name: 'Task details' }).locator('.task-checkbox');
    await expect(titleCheckbox).toHaveClass(/checked/);

    const task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_complete_task')
    );
    expect(task.isCompleted).toBe(true);
    expect(task.remainingHours).toBe(0);

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('a task with two scheduled blocks does not auto-complete after the first, only after the second, is marked done', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithTwoBlocksToday(page, { idPrefix: 'e2e_auto_two' });
    await openTaskDetail(page, 'E2E Multi-Block Task');

    const scheduledRows = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRows).toHaveCount(2);

    // Mark only the first (earlier) block done — 0.5h of a 4h task. Must NOT
    // auto-complete yet, since 3.5h of work is still unaccounted for.
    await scheduledRows.nth(0).locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);

    let task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_two_task')
    );
    expect(task.isCompleted).toBe(false);
    await expect(page.getByRole('dialog', { name: 'Task details' }).locator('.task-checkbox')).not.toHaveClass(/checked/);

    // Mark the second (later) block done too. The seed data's two blocks
    // (0.5h + 1h) still don't cover the full 4h estimate, so the task
    // correctly remains open — this is the "must not fire early" half of the
    // requirement; the next test covers a task whose blocks DO fully cover
    // its estimate, which should complete on the second block.
    await scheduledRows.nth(1).locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);

    task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_two_task')
    );
    expect(task.isCompleted).toBe(false);
    expect(task.remainingHours).toBeCloseTo(2.5, 5);

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('a task whose two blocks cover its FULL estimate auto-completes only once the second block is marked done', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await page.evaluate(() => {
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const earlierStart = new Date(now.getTime() - 60 * 60000);
      const earlierEnd = new Date(now.getTime() - 30 * 60000);
      const laterStart = new Date(now.getTime() - 20 * 60000);
      const laterEnd = new Date(now.getTime() - 5 * 60000);
      const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

      const task = {
        id: 'e2e_auto_full_task',
        title: 'E2E Full Coverage Task',
        isCompleted: false,
        isLocked: false,
        estimatedHours: 1,
        remainingHours: 1,
        priority: 'medium',
        dependsOn: [],
        minChunkHours: 0.25,
        maxChunkHours: 4,
        source: 'manual',
        projectId: null,
        dueDate: todayIso,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const blockEarlier = {
        id: 'e2e_auto_full_earlier',
        taskId: task.id,
        date: todayIso,
        startTime: hm(earlierStart),
        endTime: hm(earlierEnd),
        durationHours: 0.5,
        isLocked: false,
        isAutoScheduled: false,
        status: 'scheduled',
      };
      const blockLater = {
        id: 'e2e_auto_full_later',
        taskId: task.id,
        date: todayIso,
        startTime: hm(laterStart),
        endTime: hm(laterEnd),
        durationHours: 0.5,
        isLocked: false,
        isAutoScheduled: false,
        status: 'scheduled',
      };
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify([task]));
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify([blockEarlier, blockLater]));
    });
    await page.reload();
    await page.waitForTimeout(700);
    await openTaskDetail(page, 'E2E Full Coverage Task');

    const scheduledRows = page.locator('.scheduled-block-row-checkable');
    await expect(scheduledRows).toHaveCount(2);

    // First half of the estimate — must not complete yet.
    await scheduledRows.nth(0).locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);
    let task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_full_task')
    );
    expect(task.isCompleted).toBe(false);
    expect(task.remainingHours).toBeCloseTo(0.5, 5);

    // Second half — remaining hours now hits exactly 0, so the task
    // auto-completes.
    await scheduledRows.nth(1).locator('input[type="checkbox"]').click();
    await page.waitForTimeout(400);
    task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_full_task')
    );
    expect(task.isCompleted).toBe(true);
    expect(task.remainingHours).toBe(0);

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('reducing "Time left" to 0 directly also auto-completes the task', async ({ page }) => {
    // Exercises the other code path — setRemainingHoursWithBlockInference,
    // not markBlockDone — per this feature's own note that both must trigger
    // the same completion.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedTaskWithOneBlockToday(page, { idPrefix: 'e2e_auto_timeleft' });
    await openTaskDetail(page, 'E2E Auto Complete Task');

    // SmartDurationInput's own "clearing the field commits 0" rule (see its
    // module comment) is the reliable way to drive this to exactly 0 — typing
    // "0h" doesn't parse to a true zero (findDurationPhrase rounds a matched
    // duration up to at least one minute, never down to 0).
    const timeLeftInput = page.locator('.detail-field', { hasText: 'Time left' }).locator('.smart-duration-input');
    await timeLeftInput.click();
    await timeLeftInput.fill('');
    await timeLeftInput.blur();
    await page.waitForTimeout(400);

    await expect(page.getByRole('dialog', { name: 'Task details' }).locator('.task-checkbox')).toHaveClass(/checked/);

    const task = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks')).find((t) => t.id === 'e2e_auto_timeleft_task')
    );
    expect(task.isCompleted).toBe(true);
    expect(task.remainingHours).toBe(0);

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });
});

test.describe('Locking "Time left" and scheduled blocks behind an incomplete dependency', () => {
  /* Seeds a dependency pair: `dep` (incomplete) and a dependent task with one
     scheduled block today, `dependsOn: [dep.id]`. areDependenciesMet returns
     false while `dep` is incomplete, which should disable both "Time left"
     and the block's own checkbox on every surface that offers one. */
  async function seedDependencyBlockedTask(page, { idPrefix = 'e2e_dep_lock', depCompleted = false } = {}) {
    await page.evaluate(([prefix, completed]) => {
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const start = new Date(now.getTime() - 60 * 60000);
      const end = new Date(now.getTime() - 5 * 60000);
      const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

      const dep = {
        id: `${prefix}_dep`,
        title: 'E2E Dependency Blocker',
        isCompleted: completed,
        isLocked: false,
        estimatedHours: 1,
        remainingHours: completed ? 0 : 1,
        priority: 'medium',
        dependsOn: [],
        minChunkHours: 0.5,
        maxChunkHours: 4,
        source: 'manual',
        projectId: null,
        dueDate: todayIso,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const task = {
        id: `${prefix}_task`,
        title: 'E2E Dependency Locked Task',
        isCompleted: false,
        isLocked: false,
        estimatedHours: 1,
        remainingHours: 1,
        priority: 'medium',
        dependsOn: [dep.id],
        minChunkHours: 0.5,
        maxChunkHours: 4,
        source: 'manual',
        projectId: null,
        dueDate: todayIso,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const block = {
        id: `${prefix}_block`,
        taskId: task.id,
        date: todayIso,
        startTime: hm(start),
        endTime: hm(end),
        durationHours: 1,
        isLocked: false,
        isAutoScheduled: false,
        status: 'scheduled',
      };
      const existingTasks = JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]');
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify([...existingTasks, dep, task]));
      const existingBlocks = JSON.parse(localStorage.getItem('taskflow:v1:blocks') || '[]');
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify([...existingBlocks, block]));
    }, [idPrefix, depCompleted]);
    await page.reload();
    await page.waitForTimeout(700);
  }

  async function openTaskDetail(page, title) {
    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill('');
    await search.fill(title);
    await page.waitForTimeout(300);
    await page.getByText(title, { exact: false }).first().click();
    await page.waitForTimeout(300);
  }

  test('TaskDetailModal disables "Time left" and the block checkbox while a dependency is incomplete, and lifts once it\'s done', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedDependencyBlockedTask(page);
    await openTaskDetail(page, 'E2E Dependency Locked Task');

    const timeLeftField = page.locator('.detail-field', { hasText: 'Time left' });
    await expect(timeLeftField.locator('.smart-duration-input')).toBeDisabled();
    await expect(timeLeftField.getByText("Locked until this task's dependencies are complete.")).toBeVisible();

    const blockCheckbox = page.locator('.scheduled-block-row-checkable input[type="checkbox"]');
    await expect(blockCheckbox).toHaveCount(1);
    await expect(blockCheckbox).toBeDisabled();
    await expect(blockCheckbox).not.toBeChecked();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Complete the dependency directly (equivalent to clicking its own
    // checkbox — this suite already covers that interaction elsewhere, so a
    // direct localStorage write keeps this test focused on the lock itself).
    await page.evaluate(() => {
      const tasks = JSON.parse(localStorage.getItem('taskflow:v1:tasks'));
      const updated = tasks.map((t) => (t.id === 'e2e_dep_lock_dep' ? { ...t, isCompleted: true, remainingHours: 0 } : t));
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify(updated));
    });
    await page.reload();
    await page.waitForTimeout(700);

    await openTaskDetail(page, 'E2E Dependency Locked Task');
    await expect(page.locator('.detail-field', { hasText: 'Time left' }).locator('.smart-duration-input')).toBeEnabled();
    await expect(page.locator('.detail-field', { hasText: 'Time left' }).getByText("Locked until this task's dependencies are complete.")).toHaveCount(0);
    await expect(page.locator('.scheduled-block-row-checkable input[type="checkbox"]')).toBeEnabled();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('an already-done block\'s checkbox stays enabled (reversible) even while the dependency is still incomplete', async ({ page }) => {
    // Defense-in-depth exception per the feature's own rule: only an
    // UNCHECKED block's checkbox is locked; a done one can still be reversed.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedDependencyBlockedTask(page, { idPrefix: 'e2e_dep_reverse' });
    // Mark the block done BEFORE introducing the dependency lock, directly in
    // localStorage (the dependency isn't blocking the write path here — this
    // is purely about what the checkbox's disabled attribute reflects).
    await page.evaluate(() => {
      const blocks = JSON.parse(localStorage.getItem('taskflow:v1:blocks'));
      const updated = blocks.map((b) =>
        b.id === 'e2e_dep_reverse_block' ? { ...b, status: 'done', hoursAppliedToRemaining: 1 } : b
      );
      localStorage.setItem('taskflow:v1:blocks', JSON.stringify(updated));
      const tasks = JSON.parse(localStorage.getItem('taskflow:v1:tasks'));
      const updatedTasks = tasks.map((t) => (t.id === 'e2e_dep_reverse_task' ? { ...t, remainingHours: 0 } : t));
      localStorage.setItem('taskflow:v1:tasks', JSON.stringify(updatedTasks));
    });
    await page.reload();
    await page.waitForTimeout(700);

    await openTaskDetail(page, 'E2E Dependency Locked Task');
    const blockCheckbox = page.locator('.scheduled-block-row-checkable input[type="checkbox"]');
    await expect(blockCheckbox).toBeChecked();
    await expect(blockCheckbox).toBeEnabled();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('Today\'s agenda and the "Overdue & missed" popup also disable a dependency-blocked block\'s checkbox', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await seedDependencyBlockedTask(page, { idPrefix: 'e2e_dep_dashboard' });
    await gotoTab(page, 'Dashboard');

    const agenda = page.locator('.today-agenda');
    await agenda.waitFor({ state: 'visible' });
    const row = agenda.locator('.today-agenda-item', { hasText: 'E2E Dependency Locked Task' }).first();
    await row.hover();
    const agendaCheckbox = row.locator('.today-agenda-block-checkbox');
    await expect(agendaCheckbox).toBeVisible();
    await expect(agendaCheckbox).toBeDisabled();

    // Same task/block also renders in the "Overdue & missed" popup (the
    // seeded block's end time is already in the past — see
    // seedDependencyBlockedTask), with the same disabled treatment.
    const strip = page.locator('.dashboard-stats-strip');
    await strip.waitFor({ state: 'visible' });
    await strip.locator('.dashboard-stat-tile', { hasText: 'Overdue & missed' }).click();
    await page.waitForTimeout(300);
    const dialog = page.getByRole('dialog', { name: 'Overdue & missed' });
    await dialog.waitFor({ state: 'visible' });
    const missedItem = dialog.locator('.missed-tasks-item', { hasText: 'E2E Dependency Locked Task' });
    await expect(missedItem).toBeVisible();
    await missedItem.hover();
    await expect(missedItem.locator('.missed-tasks-block-checkbox')).toBeDisabled();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });
});
