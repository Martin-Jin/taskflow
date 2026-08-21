// Full-suite — the Projects directory page (tab id 'projects'): navigation
// into it (sidebar nav item, mobile bottom tab bar), its fuzzy project
// search (filters the three columns in place), the "My projects" sort menu,
// and clicking a row to jump to Tasks with that project active. See
// helpers.js for shared setup.
//
// Seeded data assumed from src/services/mockData.js: three projects — Work
// (order 1, 9 tasks incl. subtasks, ~21.25 top-level effective hours),
// Writing (order 2, 1 task, 4 hours), Personal (order 3, 3 tasks, 7 hours).
// By both "Size" (task count) and "Duration" (hours), the descending order is
// Work > Personal > Writing — see that file if these tests start failing for
// data reasons rather than code reasons.
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, trackConsoleErrors, expectNoErrors } from './helpers';

// Confirms the Tasks page landed on `name` as its active project, by reading
// the page's own title heading directly (TaskListPanel's .taskpage-project-title) —
// used to confirm ProjectsPage's navigation landed on the right one.
async function expectActiveProject(page, name) {
  await expect(page.getByPlaceholder(/search tasks/i)).toBeVisible();
  await expect(page.locator('.taskpage-project-title')).toContainText(name);
}

test.describe('Projects page', () => {
  test('sidebar nav renders the page with its title, search bar, and three columns', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByLabel('Search projects')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shared', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My projects', exact: true })).toBeVisible();

    // "My projects" is the full directory, so all three seeded projects
    // should be listed there regardless of Recent/Shared's own contents.
    const myProjectsColumn = page.locator('.projects-page-column', { has: page.getByRole('heading', { name: 'My projects', exact: true }) });
    await expect(myProjectsColumn.getByText('Work', { exact: true })).toBeVisible();
    await expect(myProjectsColumn.getByText('Writing', { exact: true })).toBeVisible();
    await expect(myProjectsColumn.getByText('Personal', { exact: true })).toBeVisible();

    expectNoErrors(errors);
  });

  test('search finds a project by partial name, arrow keys + Enter select it, and it navigates to Tasks with that project active', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const searchInput = page.getByLabel('Search projects');
    await searchInput.fill('Wor');
    await page.waitForTimeout(200);

    const dropdown = page.locator('#projects-page-search-listbox');
    await expect(dropdown).toBeVisible();
    const workOption = dropdown.getByRole('option', { name: 'Work' });
    await expect(workOption).toBeVisible();
    // Only one result should match "Wor" among the three seeded projects.
    await expect(dropdown.getByRole('option')).toHaveCount(1);

    // Keyboard nav: the single result starts active; Down should be a no-op
    // wrap back onto it (only one item), then Enter selects it.
    await searchInput.press('ArrowDown');
    await expect(workOption).toHaveAttribute('aria-selected', 'true');
    await searchInput.press('Enter');
    await page.waitForTimeout(400);

    await expectActiveProject(page, 'Work');

    expectNoErrors(errors);
  });

  test('typing Escape while searching clears the query without navigating away', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const searchInput = page.getByLabel('Search projects');
    await searchInput.fill('Writing');
    await page.waitForTimeout(200);
    await expect(page.locator('#projects-page-search-listbox')).toBeVisible();

    await searchInput.press('Escape');
    await expect(searchInput).toHaveValue('');
    await expect(page.locator('#projects-page-search-listbox')).toHaveCount(0);
    // Still on the Projects page — Escape only cleared the query.
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

    expectNoErrors(errors);
  });

  test('a query matching nothing shows the empty state', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const searchInput = page.getByLabel('Search projects');
    await searchInput.fill('zzzznonexistentprojectzzzz');
    await page.waitForTimeout(200);
    await expect(page.locator('#projects-page-search-listbox')).toContainText('Nothing matches');

    expectNoErrors(errors);
  });

  test('"My projects" sort menu: switching key and order actually reorders the rows', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const myProjectsColumn = page.locator('.projects-page-column', { has: page.getByRole('heading', { name: 'My projects', exact: true }) });
    // "My projects" always has the Inbox pseudo-project pinned above the real,
    // sortable rows (see ProjectsPage's leadingRow) — excluded here since it's
    // never part of the sort itself.
    const rowNames = async () => (await myProjectsColumn.locator('.projects-page-row-name').allInnerTexts()).filter((n) => n !== 'Inbox');

    // Default is Size, descending — Work (9 tasks) > Personal (3) > Writing (1).
    await expect.poll(rowNames).toEqual(['Work', 'Personal', 'Writing']);

    const sortTrigger = page.getByRole('button', { name: 'Sort my projects' });

    // Flip to ascending (still Size) — order reverses.
    await sortTrigger.click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitemradio', { name: 'Ascending', exact: true }).click();
    await page.waitForTimeout(200);
    await expect.poll(rowNames).toEqual(['Writing', 'Personal', 'Work']);

    // Switch to Duration while still ascending — hours give the same
    // relative order as task count for this seed data (Writing 4h < Personal
    // 7h < Work 21.25h), so this confirms the sort key actually changed the
    // menu's selection (not just a no-op) while keeping order internally
    // consistent (non-decreasing for ascending).
    await sortTrigger.click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitemradio', { name: 'Duration', exact: true }).click();
    await page.waitForTimeout(200);
    await expect.poll(rowNames).toEqual(['Writing', 'Personal', 'Work']);
    await sortTrigger.click();
    await page.waitForTimeout(150);
    await expect(page.getByRole('menuitemradio', { name: 'Duration', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemradio', { name: 'Ascending', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // Back to Descending (still Duration) — order flips back.
    await sortTrigger.click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitemradio', { name: 'Descending', exact: true }).click();
    await page.waitForTimeout(200);
    await expect.poll(rowNames).toEqual(['Work', 'Personal', 'Writing']);

    // Creation date, descending — 'order' is stamped in creation sequence
    // (Work=1, Writing=2, Personal=3), so newest-first is Personal > Writing > Work.
    await sortTrigger.click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitemradio', { name: 'Creation date', exact: true }).click();
    await page.waitForTimeout(200);
    await expect.poll(rowNames).toEqual(['Personal', 'Writing', 'Work']);

    expectNoErrors(errors);
  });

  test('Inbox pseudo-project row appears above "My projects" and navigates to Tasks with Inbox selected', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const myProjectsColumn = page.locator('.projects-page-column', { has: page.getByRole('heading', { name: 'My projects', exact: true }) });
    const inboxRow = myProjectsColumn.locator('.projects-page-row', { hasText: 'Inbox' });
    await expect(inboxRow).toBeVisible();
    // Seeded mock data assigns every task to a real project, so Inbox (tasks
    // with no projectId) is empty here — 0 tasks/0h.
    await expect(inboxRow).toContainText('0 tasks');

    await inboxRow.click();
    await page.waitForTimeout(400);
    await expectActiveProject(page, 'Inbox');

    expectNoErrors(errors);
  });

  test('clicking a project row navigates to Tasks with that project selected', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    const myProjectsColumn = page.locator('.projects-page-column', { has: page.getByRole('heading', { name: 'My projects', exact: true }) });
    await myProjectsColumn.locator('.projects-page-row', { hasText: 'Writing' }).click();
    await page.waitForTimeout(400);

    await expectActiveProject(page, 'Writing');

    expectNoErrors(errors);
  });

  // Same AddTaskFabGroup speed-dial pattern as the Tasks list/Board FABs (see
  // search-shortcuts-undo.spec.js's command-palette AI Quick Add test) —
  // ProjectsPage now renders its own instance instead of relying on App.jsx's
  // AI-only standalone FAB, so "Add project" is reachable the same way "Add
  // task" already is elsewhere.
  test('FAB group: expands into "Add project" and AI Quick Add, and "Add project" opens the dedicated add-project modal', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Projects');

    await page.locator('.add-task-btn').last().click();
    await page.waitForTimeout(300);

    const addProjectMini = page.locator('.fab-mini[aria-label="Add project"]');
    await expect(addProjectMini).toBeVisible();
    await addProjectMini.click();
    await page.waitForTimeout(400);

    // Opens the dedicated AddProjectModal (styled like AddTaskModal), the
    // same modal ManageProjectsModal's own "Add project" button now opens too.
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder('Project name')).toBeVisible();

    expectNoErrors(errors);
  });

  test('FAB group: AI Quick Add mini-FAB opens the AI Quick Add modal (with a key configured)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    // Same fake-key seeding as search-shortcuts-undo.spec.js's command-palette
    // AI Quick Add test — isAIQuickAddConfigured (build-time gate) shows the
    // entry point regardless, but opening the modal itself also needs a
    // stored provider key (see useAIQuickAddGate's requestOpen).
    await page.evaluate(() => {
      window.localStorage.setItem('taskflow:v1:aiGeminiApiKey', JSON.stringify('e2e-fake-test-key'));
    });
    await gotoTab(page, 'Projects');

    await page.locator('.add-task-btn').last().click();
    await page.waitForTimeout(300);
    await page.locator('.fab-mini[aria-label="AI Quick Add"]').click();
    await page.waitForTimeout(400);

    await expect(page.getByRole('dialog', { name: /AI Quick Add/i })).toBeVisible();

    expectNoErrors(errors);
  });
});

test.describe('Projects page — mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('reachable via the bottom tab bar (no sidebar on mobile) and its three columns stack usably', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // No desktop sidebar at this width — the "Projects" destination instead
    // lives in BottomTabBar (App.jsx only renders Sidebar when !isMobile).
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await page.locator('.bottom-tab-item', { hasText: 'Projects' }).click();
    await page.waitForTimeout(300);

    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

    // No horizontal overflow at this width.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390 + 1); // +1px rounding tolerance

    // Columns are usable stacked vertically: each header is visible, and
    // (being a narrow single-column layout) the second column header sits
    // below the first's content rather than side-by-side.
    const headers = page.locator('.projects-page-column-header');
    await expect(headers).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(headers.nth(i)).toBeVisible();
    const firstBox = await page.locator('.projects-page-column').nth(0).boundingBox();
    const secondBox = await page.locator('.projects-page-column').nth(1).boundingBox();
    expect(secondBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height - 1);

    // A row is still clickable and reachable at this width.
    const myProjectsColumn = page.locator('.projects-page-column', { has: page.getByRole('heading', { name: 'My projects', exact: true }) });
    await myProjectsColumn.locator('.projects-page-row', { hasText: 'Personal' }).click();
    await page.waitForTimeout(400);
    await expectActiveProject(page, 'Personal');

    expectNoErrors(errors);
  });
});
