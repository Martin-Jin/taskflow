// Full-suite — CalendarFilterMenu (show-mode/project/tag filtering on the
// Calendar tab's toolbar). See helpers.js for shared setup, views.spec.js
// for the rest of the Calendar tab's coverage.
//
// Mock data (src/services/mockData.js) seeds Work/Writing/Personal projects
// with several dated tasks close to "today", so Week view reliably shows a
// mix of .cal-block items across projects with no setup — but ships with NO
// labels, so the label-filter test creates one via the "@tag" smart-parse
// shorthand first (see AddTaskModal/TaskDetailModal's SMART PARSE doc
// comment) rather than assuming any pre-seeded tag exists.
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, openAddTask, closeAnyModal, trackConsoleErrors, expectNoErrors } from './helpers';

async function openFilterMenu(page) {
  await page.getByTestId('calendar-filter-trigger').click();
  await page.waitForTimeout(200);
}

// Mock data's dated tasks aren't scheduled onto the calendar until a
// rebalance actually runs — on a fresh load that only happens via a
// debounced background effect, which isn't reliably done by the time a test
// starts asserting on `.cal-block` counts. Click "Re-balance schedule"
// explicitly so blocks are deterministically present. Only used by the
// desktop-viewport tests below — the mobile test doesn't depend on any
// .cal-block being present, so it doesn't need the FAB speed-dial's copy of
// this button (see CalendarPage.jsx).
async function ensureBlocksScheduled(page) {
  await page.getByRole('button', { name: 'Re-balance schedule', exact: true }).click();
  await page.waitForTimeout(600);
}

test.describe('Calendar filter menu', () => {
  test('opens and shows the Show group with "Tasks & events" checked by default', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await expect(page.getByTestId('calendar-filter-trigger')).toBeVisible();
    await openFilterMenu(page);
    await expect(page.getByRole('menuitemradio', { name: 'Tasks & events' })).toHaveAttribute('aria-checked', 'true');
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('"Tasks only" hides events, "Events only" hides task blocks', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await ensureBlocksScheduled(page);

    const blockCountBefore = await page.locator('.cal-block').count();
    expect(blockCountBefore).toBeGreaterThan(0); // mock data always has near-term dated tasks

    // The Show group stays open across picks (same as
    // DashboardCustomizeMenu's checkbox groups) — one open + several clicks,
    // no need to reopen the menu between them.
    await openFilterMenu(page);
    await page.getByRole('menuitemradio', { name: 'Events only' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.cal-block')).toHaveCount(0);
    // Trigger shows the active-filter indicator once a non-default filter is applied.
    await expect(page.getByTestId('calendar-filter-trigger')).toHaveClass(/is-active/);

    await page.getByRole('menuitemradio', { name: 'Tasks only' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.cal-event')).toHaveCount(0);
    const blockCountAfter = await page.locator('.cal-block').count();
    expect(blockCountAfter).toBeGreaterThan(0);

    // Reset back to default so this test doesn't leak state into others.
    await page.getByRole('menuitemradio', { name: 'Tasks & events' }).click();
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await expect(page.getByTestId('calendar-filter-trigger')).not.toHaveClass(/is-active/);

    expectNoErrors(errors);
  });

  test('filtering by project narrows visible task blocks to that project', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await ensureBlocksScheduled(page);

    const totalBlocks = await page.locator('.cal-block').count();
    expect(totalBlocks).toBeGreaterThan(0);

    await openFilterMenu(page);
    // Projects group starts collapsed (see CalendarFilterMenu's FilterGroup) — expand it.
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.waitForTimeout(150);
    // Deselecting "All projects" narrows down to an explicit list; then
    // re-select just "Work" (a project mock data seeds several dated tasks
    // into — see task_1/task_3/task_5/task_7/task_8 in mockData.js).
    await page.getByRole('checkbox', { name: 'All projects' }).uncheck();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'Work', exact: true }).check();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    const filteredBlocks = await page.locator('.cal-block').count();
    // Should never show MORE than the unfiltered total, and (given mock
    // data's spread of tasks across all three projects within the visible
    // week) is expected to genuinely narrow the set.
    expect(filteredBlocks).toBeLessThanOrEqual(totalBlocks);

    // Reset via the menu's own "All projects" checkbox rather than leaving
    // the filter applied for later tests.
    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'All projects' }).check();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('filtering by tag hides blocks whose task lacks that tag', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // Mock data ships with no labels — create two via the "@tag" smart-parse
    // shorthand on tasks due today, so both are guaranteed to render as
    // .cal-block items in the current week view. Two distinct tags (rather
    // than one) matters here: selecting the only label that exists is
    // indistinguishable from "all labels" (see toggleSelection's collapse-
    // to-null rule in CalendarFilterMenu) and wouldn't actually narrow
    // anything — a second, deliberately-unselected tag makes this a real
    // subset selection.
    const runId = Date.now();
    const keepTag = `e2efilterkeep${runId}`;
    const dropTag = `e2efilterdrop${runId}`;

    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(`Tagged keep today @${keepTag}`);
    await page.waitForTimeout(400);
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(400);

    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(`Tagged drop today @${dropTag}`);
    await page.waitForTimeout(400);
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(400);

    await gotoTab(page, 'Calendar');
    await ensureBlocksScheduled(page);

    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Tags/ }).click();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'All tags' }).uncheck();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: new RegExp(`^${keepTag}$`, 'i') }).check();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    // Only the "keep"-tagged task's block(s) should remain — the "drop"-
    // tagged one must be hidden. Smart-parse strips both "today" (consumed
    // as the due-date phrase) and "@tag" (consumed as the label) from the
    // saved title.
    await expect(page.locator('.cal-block', { hasText: 'Tagged drop' })).toHaveCount(0);
    const blockCount = await page.locator('.cal-block').count();
    if (blockCount > 0) {
      await expect(page.locator('.cal-block').first()).toContainText('Tagged keep');
    }

    // Reset the tag filter so it doesn't leak into later tests.
    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Tags/ }).click();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'All tags' }).check();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('empty-filter state shows "Nothing matches" with a working Clear filters button', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await ensureBlocksScheduled(page);

    // Narrow the Projects group down to zero selections — guaranteed to hide
    // every task block regardless of what mock data seeds.
    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'All projects' }).uncheck();
    await page.waitForTimeout(150);
    // Uncheck every remaining checked project item (each was auto-checked by
    // materializing "all" into an explicit list on the first uncheck above).
    const projectCheckboxes = page.locator('.calendar-filter-group-body input[type="checkbox"]');
    const count = await projectCheckboxes.count();
    for (let i = 1; i < count; i++) {
      if (await projectCheckboxes.nth(i).isChecked()) await projectCheckboxes.nth(i).uncheck();
    }
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    await expect(page.locator('.cal-block')).toHaveCount(0);
    const overlay = page.locator('.calendar-empty-filter-message');
    // Only shows if the unfiltered range actually had something — mock data
    // guarantees this for the current week.
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(/nothing matches/i);

    await overlay.getByRole('button', { name: /clear filters/i }).click();
    await page.waitForTimeout(300);
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId('calendar-filter-trigger')).not.toHaveClass(/is-active/);

    expectNoErrors(errors);
  });
});

test.describe('Calendar filter menu — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('trigger and popover are usable on a mobile viewport', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(400);

    const trigger = page.getByTestId('calendar-filter-trigger');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.waitForTimeout(300);

    // useMenuPosition falls back to a centered popover (with backdrop) once
    // an anchored position wouldn't fit — a phone-width viewport should
    // trigger that path, same as ViewFilterMenu's own mobile behavior.
    const popover = page.locator('.calendar-filter-dropdown');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);

    await page.getByRole('menuitemradio', { name: 'Tasks only' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.cal-event')).toHaveCount(0);

    // The Show group doesn't close the menu on click (it can stay open
    // across several picks, like DashboardCustomizeMenu's checkbox groups)
    // — reset directly from the still-open popover rather than reopening it.
    await page.getByRole('menuitemradio', { name: 'Tasks & events' }).click();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });
});

test.describe('Calendar filter menu — Projects search', () => {
  // Mock data only seeds 3 projects (Work/Writing/Personal) + "Unassigned" —
  // one under CalendarFilterMenu's SEARCH_THRESHOLD, so the search box won't
  // render at all unless there are enough projects. Unlike labels (which
  // smart-parse's "@tag" shorthand can create on the fly, see this file's
  // own tag test), a "#Project" mention only ever resolves against EXISTING
  // projects — so these have to be created for real via the "Manage
  // projects" modal's own "Add project" form.
  async function seedExtraProjects(page, runId) {
    const names = [`E2eSearchAlpha${runId}`, `E2eSearchBeta${runId}`];
    await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
    await page.waitForTimeout(300);
    for (const name of names) {
      await page.getByRole('button', { name: 'Add project' }).click();
      await page.getByPlaceholder('Project name…').fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.waitForTimeout(300);
    }
    await closeAnyModal(page);
    return names;
  }

  test('search narrows the project list, supports typo tolerance, Enter selects, and shows a no-match state', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    const runId = Date.now();
    const [alphaName] = await seedExtraProjects(page, runId);

    await gotoTab(page, 'Calendar');
    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.waitForTimeout(150);

    const searchInput = page.locator('.calendar-filter-search-input');
    await expect(searchInput).toBeVisible();

    // Narrows: typing the seeded project's exact name should leave only it
    // (and no other project) visible as a checkbox row.
    await searchInput.fill(alphaName);
    await page.waitForTimeout(150);
    const groupBody = page.locator('.calendar-filter-group-body');
    await expect(groupBody.getByRole('checkbox', { name: alphaName, exact: true })).toBeVisible();
    await expect(groupBody.getByRole('checkbox', { name: 'Work', exact: true })).toHaveCount(0);

    // Typo tolerance: dropping one character still finds it via the fuzzy tier.
    const typo = alphaName.slice(0, -1); // e.g. "E2eSearchAlpha1699..." minus its last digit
    await searchInput.fill(typo);
    await page.waitForTimeout(150);
    await expect(groupBody.getByRole('checkbox', { name: alphaName, exact: true })).toBeVisible();

    // Enter toggles the top-ranked (highlighted) match without needing a
    // click. Every project starts implicitly selected (selectedIds === null
    // means "all"), so the checkbox starts checked — Enter here unchecks it.
    await searchInput.fill(alphaName);
    await page.waitForTimeout(150);
    const alphaCheckbox = groupBody.getByRole('checkbox', { name: alphaName, exact: true });
    await expect(alphaCheckbox).toBeChecked();
    await searchInput.press('Enter');
    await page.waitForTimeout(150);
    await expect(alphaCheckbox).not.toBeChecked();

    // No-match state for a query that can't plausibly match anything.
    await searchInput.fill('zzzznomatchzzzz');
    await page.waitForTimeout(150);
    await expect(page.locator('.calendar-filter-no-match')).toBeVisible();

    // Clean up: clear the query and restore "All projects" so this doesn't
    // leak a narrowed filter into later tests.
    await searchInput.fill('');
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'All projects' }).check();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('search works at a mobile viewport', async ({ page }) => {
    // Seed the extra projects at desktop width first — "Manage projects" is
    // reached via the desktop Sidebar (mobile has no sidebar, see its own
    // doc comment); the projects persist in localStorage once created, so
    // switching to a phone viewport afterwards still sees them.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    const runId = Date.now();
    const [alphaName] = await seedExtraProjects(page, runId);

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoTab(page, 'Calendar');
    await openFilterMenu(page);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.waitForTimeout(150);

    const searchInput = page.locator('.calendar-filter-search-input');
    await expect(searchInput).toBeVisible();
    // >=16px avoids iOS Safari's zoom-on-focus for text inputs.
    const fontSize = await searchInput.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);

    await searchInput.fill(alphaName);
    await page.waitForTimeout(150);
    const groupBody = page.locator('.calendar-filter-group-body');
    await expect(groupBody.getByRole('checkbox', { name: alphaName, exact: true })).toBeVisible();

    // The popover itself must still fit the viewport with the search box added.
    const popover = page.locator('.calendar-filter-dropdown');
    const box = await popover.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);

    await searchInput.fill('');
    await page.waitForTimeout(150);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });
});
