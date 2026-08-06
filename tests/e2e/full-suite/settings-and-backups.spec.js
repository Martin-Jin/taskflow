// Full-suite regression coverage for the Settings tab (SettingsPanel.jsx) and
// its modals: Labels, Manage Projects, Backups, Shortcuts, Changelog, theme
// toggle, notification settings, and the guided tour restart entry point.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { trackConsoleErrors, gotoApp, gotoTab, openAddTask, closeAnyModal, expectNoErrors } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test('Labels modal: create via @tag, rename, and delete a label', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const tagName = `e2etag${Date.now()}`;

  // Labels are created implicitly by using "@tag" in a task title — there's
  // no standalone "add label" button in LabelsModal itself.
  await openAddTask(page);
  await page.getByPlaceholder('Task name').fill(`E2E label source task @${tagName}`);
  await page.waitForTimeout(300);
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(500);

  await gotoTab(page, 'Settings');
  await page.getByRole('button', { name: /view all tags/i }).click();
  const dialog = page.getByRole('dialog', { name: 'All tags' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(tagName, { exact: true })).toBeVisible();

  // Rename it.
  const renamedName = `${tagName}-renamed`;
  await dialog.getByRole('button', { name: `Rename ${tagName}` }).click();
  const renameInput = dialog.locator('input').first();
  await renameInput.fill(renamedName);
  await renameInput.press('Enter');
  await page.waitForTimeout(300);
  await expect(dialog.getByText(renamedName, { exact: true })).toBeVisible();
  await expect(dialog.getByText(tagName, { exact: true })).toHaveCount(0);

  // Delete it — confirm() is auto-accepted below.
  page.once('dialog', (d) => d.accept());
  await dialog.getByRole('button', { name: `Delete ${renamedName}` }).click();
  await page.waitForTimeout(300);
  await expect(dialog.getByText(renamedName, { exact: true })).toHaveCount(0);

  // Note: LabelsModal's renameLabel (SchedulerContext.jsx) has no
  // duplicate-name check — renaming to a name that already exists is
  // allowed today (two distinct label ids can share a display name), so
  // there's no validation-error UI to assert here.

  await closeAnyModal(page);
  expectNoErrors(errors);
});

test('Manage Projects modal: create, rename, appears in Add Task picker, delete reassigns tasks', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const projectName = `E2E Project ${Date.now()}`;
  const renamedProjectName = `${projectName} Renamed`;

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await expect(dialog.getByText(projectName, { exact: true })).toBeVisible();

  // Rename via ProjectActionsMenu ("..." menu on the project row).
  const projectRow = dialog.locator('.sidebar-project-row-wrap', { hasText: projectName });
  await projectRow.getByRole('button', { name: `Actions for ${projectName}` }).click();
  await page.getByRole('menuitem', { name: /rename/i }).or(page.getByText('Rename', { exact: true })).first().click();
  const renameInput = dialog.getByLabel(`Rename project "${projectName}"`);
  await renameInput.fill(renamedProjectName);
  await renameInput.press('Enter');
  await page.waitForTimeout(400);
  await expect(dialog.getByText(renamedProjectName, { exact: true })).toBeVisible();

  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // Verify it appears in the Add Task project picker.
  await openAddTask(page);
  const addTaskDialog = page.getByRole('dialog');
  await addTaskDialog.getByRole('button', { name: 'Project', exact: true }).click();
  const projectListbox = page.getByRole('listbox', { name: 'Project' });
  await expect(projectListbox).toBeVisible();
  await expect(projectListbox.getByRole('option', { name: renamedProjectName })).toBeVisible();
  // Assign the new task to this project so we can check reassignment after delete.
  await projectListbox.getByRole('option', { name: renamedProjectName }).click();
  await page.getByPlaceholder('Task name').fill(`E2E task in ${renamedProjectName}`);
  await page.waitForTimeout(200);
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(500);

  // Delete the project — its task(s) should move to "All Tasks" per the
  // confirm-dialog copy in ManageProjectsModal ("Its tasks will move to All Tasks").
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog2 = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(dialog2).toBeVisible();
  const projectRow2 = dialog2.locator('.sidebar-project-row-wrap', { hasText: renamedProjectName });
  await projectRow2.getByRole('button', { name: `Actions for ${renamedProjectName}` }).click();
  page.once('dialog', (d) => {
    expect(d.message()).toMatch(/move to All Tasks/i);
    d.accept();
  });
  await page.getByText('Delete', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await expect(dialog2.getByText(renamedProjectName, { exact: true })).toHaveCount(0);

  await closeAnyModal(page);
  // Confirm the task itself survived (reassigned, not deleted) by finding it under All Tasks / search.
  await gotoTab(page, 'Tasks');
  await page.getByPlaceholder(/search tasks/i).fill(`E2E task in ${renamedProjectName}`);
  await page.waitForTimeout(400);
  await expect(page.getByText(`E2E task in ${renamedProjectName}`, { exact: false }).first()).toBeVisible();

  expectNoErrors(errors);
});

test('Manage Projects modal search is typo-tolerant (same ranker as the Sidebar and Calendar filter)', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const runId = Date.now();
  const projectName = `E2eTypoSearch${runId}`;

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await expect(dialog.getByText(projectName, { exact: true })).toBeVisible();

  // Dropping the trailing digit is a one-edit-distance typo of the seeded
  // name — should still surface it via the shared nameSearch.js ranker's
  // fuzzy tier, same as the Calendar filter's own Projects search box.
  const searchInput = dialog.getByPlaceholder('Search projects…');
  await searchInput.fill(projectName.slice(0, -1));
  await page.waitForTimeout(200);
  await expect(dialog.getByText(projectName, { exact: true })).toBeVisible();

  // A query with no plausible match (even fuzzily) shows the "no projects
  // match" empty state instead of a stale/full list.
  await searchInput.fill('zzzznomatchzzzz');
  await page.waitForTimeout(200);
  await expect(dialog.getByText(projectName, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('No projects match.')).toBeVisible();

  await searchInput.fill('');
  await closeAnyModal(page);
  expectNoErrors(errors);
});

test('Sidebar project search is typo-tolerant and keeps pinned/recency order for equal-quality matches', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const runId = Date.now();
  const projectName = `E2eSidebarTypo${runId}`;

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  const sidebarSearch = page.getByLabel('Search projects');
  // Same one-edit-distance-typo case as the Manage Projects modal test above
  // — the Sidebar's search box is now backed by the same nameSearch.js
  // ranker, not a plain substring `.includes()`.
  await sidebarSearch.fill(projectName.slice(0, -1));
  await page.waitForTimeout(200);
  await expect(page.locator('.sidebar-project-row-wrap', { hasText: projectName })).toBeVisible();

  await sidebarSearch.fill('');
  await page.waitForTimeout(200);
  expectNoErrors(errors);
});

test('Sidebar project search: Arrow keys move the highlighted row and Enter selects it', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const runId = Date.now();
  const projectName = `E2eSidebarKbd${runId}`;

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  const sidebarSearch = page.getByLabel('Search projects');
  // A query narrow enough to isolate just the seeded project as the only
  // (and therefore highlighted-by-default) result.
  await sidebarSearch.fill(projectName);
  await page.waitForTimeout(200);
  const row = page.locator('.sidebar-project-row-wrap', { hasText: projectName });
  await expect(row).toHaveClass(/is-kbd-active/);

  // With only one result, ArrowDown wraps back onto the same (only) row
  // (Sidebar uses useListKeyboardNav's default wrap: true) — still exercises
  // the key handler without needing a second seeded project.
  await sidebarSearch.press('ArrowDown');
  await page.waitForTimeout(100);
  await expect(row).toHaveClass(/is-kbd-active/);

  await sidebarSearch.press('Enter');
  await page.waitForTimeout(300);
  // Enter on the highlighted row selects it, same as clicking it — the
  // Tasks page's "All Tasks"/project switcher should now show this project.
  await gotoTab(page, 'Tasks');
  // The project title <h2> loses its implicit "heading" role once a project
  // is active (it becomes role="button" so it's click-to-rename — see
  // TaskListPanel.jsx) — check by class/text instead of getByRole.
  await expect(page.locator('.taskpage-project-title', { hasText: projectName })).toBeVisible();

  // Escape clears the query (checked on a fresh sidebar search afterwards).
  await sidebarSearch.fill(projectName);
  await page.waitForTimeout(150);
  await sidebarSearch.press('Escape');
  await page.waitForTimeout(150);
  await expect(sidebarSearch).toHaveValue('');

  expectNoErrors(errors);
});

test('Manage Projects modal search: Arrow keys move the highlighted row and Enter selects it', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const runId = Date.now();
  const projectName = `E2eManageKbd${runId}`;

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog2 = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(dialog2).toBeVisible();
  const searchInput = dialog2.getByPlaceholder('Search projects…');
  await searchInput.fill(projectName);
  await page.waitForTimeout(200);
  const row = dialog2.locator('.sidebar-project-row-wrap', { hasText: projectName });
  await expect(row).toHaveClass(/is-kbd-active/);

  await searchInput.press('Enter');
  await page.waitForTimeout(400);
  // Enter picks the highlighted project, same as clicking its row — clicking
  // a row closes the modal and switches the active Tasks view (pickProject).
  await expect(dialog2).not.toBeVisible();
  await gotoTab(page, 'Tasks');
  // The project title <h2> loses its implicit "heading" role once a project
  // is active (it becomes role="button" so it's click-to-rename — see
  // TaskListPanel.jsx) — check by class/text instead of getByRole.
  await expect(page.locator('.taskpage-project-title', { hasText: projectName })).toBeVisible();

  // Escape closes the whole modal here rather than only clearing the query
  // — useModalA11y's capture-phase Escape handler always wins over this
  // input's own bubble-phase handler, same as this modal's existing
  // rename-input Escape (see ManageProjectsModal's own comment on this).
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog3 = page.getByRole('dialog', { name: 'Manage projects' });
  const searchInput2 = dialog3.getByPlaceholder('Search projects…');
  await searchInput2.fill(projectName);
  await page.waitForTimeout(150);
  await searchInput2.press('Escape');
  await page.waitForTimeout(150);
  await expect(dialog3).not.toBeVisible();

  expectNoErrors(errors);
});

test('Manage Projects modal search works at a mobile viewport (tap-to-select, no stuck highlight)', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const runId = Date.now();
  const projectName = `E2eManageMobile${runId}`;

  // Create the project at default (desktop) viewport first — "Manage
  // projects" is reachable from the Sidebar there; the mobile viewport
  // switch below then reaches the same modal via the Tasks page's combined
  // view/filter/project "⋯" menu instead (mobile has no Sidebar, and folds
  // "See / manage all projects" into that popover rather than the desktop's
  // inline button next to the project title — see ViewFilterMenu).
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage projects' });
  await dialog.getByRole('button', { name: /^add project$/i }).click();
  await dialog.getByPlaceholder('Project name…').fill(projectName);
  await dialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoTab(page, 'Tasks');
  await page.getByRole('button', { name: 'View, filter, and project actions' }).click();
  await page.getByText('See / manage all projects').click();
  const mobileDialog = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(mobileDialog).toBeVisible();

  const searchInput = mobileDialog.getByPlaceholder('Search projects…');
  await searchInput.fill(projectName);
  await page.waitForTimeout(200);
  const row = mobileDialog.locator('.sidebar-project-row-wrap', { hasText: projectName });
  // The keyboard-nav highlight is desktop-relevant, but shouldn't visually
  // break a touch tap — a plain click on the row (mobile viewports here run
  // without a touch-enabled browser context, same as every other mobile
  // test in this suite, so .click() stands in for a tap) must still select
  // the project regardless of whether it happens to be the keyboard-
  // highlighted one.
  await row.getByText(projectName, { exact: true }).click();
  await page.waitForTimeout(400);
  await expect(mobileDialog).not.toBeVisible();
  await expect(page.locator('.taskpage-project-title', { hasText: projectName })).toBeVisible();

  expectNoErrors(errors);
});

test('Tasks page header "See / manage all projects" button opens Manage Projects on desktop, for both All Tasks and a named project', async ({ page }) => {
  const errors = trackConsoleErrors(page);

  await gotoTab(page, 'Tasks');
  // "All Tasks" (no active project) still gets the button — managing
  // projects isn't specific to any one project.
  await expect(page.locator('.taskpage-project-title', { hasText: 'All Tasks' })).toBeVisible();
  await page.getByRole('button', { name: 'See / manage all projects' }).click();
  await expect(page.getByRole('dialog', { name: 'Manage projects' })).toBeVisible();
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // Switch to a real project and confirm the same button is still there,
  // right next to the (now different) project title.
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'See / manage all projects' }).click();
  await expect(page.getByRole('dialog', { name: 'Manage projects' })).toBeVisible();
  await closeAnyModal(page);

  expectNoErrors(errors);
});

test('Deleting the project currently selected as the Tasks view falls back to All Tasks', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const projectName = `E2E Active Filter Project ${Date.now()}`;

  // Create a throwaway project and select it as the active Tasks view.
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const manageDialog = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(manageDialog).toBeVisible();
  await manageDialog.getByRole('button', { name: /^add project$/i }).click();
  await manageDialog.getByPlaceholder('Project name…').fill(projectName);
  await manageDialog.getByRole('button', { name: /^add$/i }).click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  await gotoTab(page, 'Tasks');
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('option', { name: projectName, exact: true }).click();
  await page.waitForTimeout(300);
  // Confirm it's actually the active selection before deleting it.
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(projectName);

  // Delete it via Manage Projects while it's still the active view.
  await page.getByRole('button', { name: 'Manage projects' }).click();
  const manageDialog2 = page.getByRole('dialog', { name: 'Manage projects' });
  await expect(manageDialog2).toBeVisible();
  const projectRow = manageDialog2.locator('.sidebar-project-row-wrap', { hasText: projectName });
  await projectRow.getByRole('button', { name: `Actions for ${projectName}` }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Delete', { exact: true }).first().click();
  await page.waitForTimeout(400);
  await closeAnyModal(page);
  await page.waitForTimeout(300);

  // The Tasks page shouldn't error or show a blank state — it should have
  // gracefully fallen back to "All Tasks" (see TaskListPanel's activeProjectId
  // effect: `if (!projects.some(...)) onChangeActiveProject(ALL_TASKS_PROJECT_ID)`).
  await gotoTab(page, 'Tasks');
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('All Tasks');
  await expect(page.getByPlaceholder(/search tasks/i)).toBeVisible();
  const taskRows = page.locator('.task-row, .board-card');
  await expect(taskRows.first()).toBeVisible();

  expectNoErrors(errors);
});

test('Backups: export/restore round trip preserves tasks and a dashboard note', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const noteTitle = `E2E note ${Date.now()}`;

  // Add a note via Dashboard (per BACKUP_FIELDS covering `notes`, not just tasks).
  await gotoTab(page, 'Dashboard');
  const noteAddBtn = page.getByRole('button', { name: /add note/i });
  if (await noteAddBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await noteAddBtn.click();
    await page.getByPlaceholder('Title').fill(noteTitle);
    await page.getByRole('button', { name: /^add$/i }).click();
    await page.waitForTimeout(300);
  }

  await gotoTab(page, 'Tasks');
  const beforeTaskCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();

  await gotoTab(page, 'Settings');
  const downloadPath = path.join(os.tmpdir(), 'taskflow-e2e-settings-backup.json');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download backup$/i }).click(),
  ]);
  await download.saveAs(downloadPath);

  const fileInput = page.locator('input[type="file"]');
  page.once('dialog', (d) => d.accept());
  await fileInput.setInputFiles(downloadPath);
  await page.waitForTimeout(600);

  await gotoTab(page, 'Tasks');
  const afterTaskCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();
  expect(afterTaskCount).toBe(beforeTaskCount);

  await gotoTab(page, 'Dashboard');
  if (await noteAddBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    // Note card is present — verify the note we added survived the restore.
    await expect(page.getByText(noteTitle, { exact: true }).first()).toBeVisible();
  }

  expectNoErrors(errors);
});

test('Backups: restoring a corrupt/invalid file shows an error and leaves existing data intact', async ({ page }) => {
  const errors = trackConsoleErrors(page);

  // Confirm the seeded "Refactor auth module" task (mockData.js) is present
  // beforehand so we can assert it survived an aborted restore.
  await gotoTab(page, 'Tasks');
  await expect(page.getByText('Refactor auth module', { exact: true })).toBeVisible();
  const beforeTaskCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();

  // Malformed JSON — readBackupFile (backupService.js) rejects with "That
  // file is not valid JSON." before isValidBackupPayload is ever reached.
  const malformedPath = path.join(os.tmpdir(), 'taskflow-e2e-malformed-backup.json');
  await fs.writeFile(malformedPath, '{ this is not valid json');

  await gotoTab(page, 'Settings');
  const fileInput = page.locator('input[type="file"]');
  page.once('dialog', (d) => d.accept());
  await fileInput.setInputFiles(malformedPath);
  await page.waitForTimeout(500);
  await expect(page.locator('.toast')).toContainText(/not valid JSON|failed to read/i);

  await gotoTab(page, 'Tasks');
  await expect(page.getByText('Refactor auth module', { exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: /^Mark .* complete$/ }).count()).toBe(beforeTaskCount);

  // Well-formed JSON but not a backup shape at all — isValidBackupPayload
  // (backupService.js) rejects it since it's missing every BACKUP_FIELDS key.
  const garbagePath = path.join(os.tmpdir(), 'taskflow-e2e-garbage-backup.json');
  await fs.writeFile(garbagePath, JSON.stringify({ garbage: true }));

  await gotoTab(page, 'Settings');
  page.once('dialog', (d) => d.accept());
  await fileInput.setInputFiles(garbagePath);
  await page.waitForTimeout(500);
  await expect(page.locator('.toast')).toContainText(/invalid backup/i);

  await gotoTab(page, 'Tasks');
  await expect(page.getByText('Refactor auth module', { exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: /^Mark .* complete$/ }).count()).toBe(beforeTaskCount);

  expectNoErrors(errors);
});

test('Shortcuts modal: lists shortcuts and closes', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Settings');
  await page.getByRole('button', { name: 'View shortcuts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  const shortcutItems = dialog.locator('.missed-tasks-item');
  await expect(shortcutItems.first()).toBeVisible();
  expect(await shortcutItems.count()).toBeGreaterThan(0);

  await closeAnyModal(page);
  await expect(dialog).toHaveCount(0);
  expectNoErrors(errors);
});

test('Changelog modal (Versions): shows entries from changelog.js and closes', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const { CURRENT_VERSION, CHANGELOG } = await import('../../../src/changelog.js');

  await gotoTab(page, 'Settings');
  await page.getByRole('button', { name: "What's new" }).click();
  const dialog = page.getByRole('dialog', { name: "What's new" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`v${CURRENT_VERSION.split('.').slice(0, 2).join('.')}`, { exact: false }).first()).toBeVisible();
  // The newest entry (CHANGELOG[0]) may be a patch-level fix collapsed under
  // its major.minor group's header rather than shown as the group's own
  // title (see ChangelogModal's grouping doc comment) — a collapsed fix
  // entry only renders its version/date and change bullets, not its title,
  // so search by (and assert on) its first change line instead, which also
  // bypasses the "2 newest groups" cap and auto-expands the matching group.
  await dialog.getByPlaceholder('Search updates…').fill(CHANGELOG[0].changes[0].slice(0, 40));
  await expect(dialog.getByText(CHANGELOG[0].changes[0], { exact: true })).toBeVisible();

  await closeAnyModal(page);
  await expect(dialog).toHaveCount(0);
  expectNoErrors(errors);
});

test('Theme toggle: switch to dark, applies data-theme, and persists after reload', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Settings');

  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Restore to light so other tests in this file (and other specs sharing
  // this same localStorage-backed app) aren't left mid-run in a dark theme.
  await gotoApp(page);
  await gotoTab(page, 'Settings');
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  expectNoErrors(errors);
});

test('Notification settings: toggles persist after reload', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Settings');

  const inAppCheckbox = page.locator('#notifInApp');
  const emailCheckbox = page.locator('#notifEmail');
  const startingSoonCheckbox = page.locator('#notifStartingSoon');
  const overdueCheckbox = page.locator('#notifOverdue');
  const dueTodayCheckbox = page.locator('#notifDueToday');

  const initialInApp = await inAppCheckbox.isChecked();
  const initialEmail = await emailCheckbox.isChecked();
  const initialStartingSoon = await startingSoonCheckbox.isChecked();
  const initialOverdue = await overdueCheckbox.isChecked();
  const initialDueToday = await dueTodayCheckbox.isChecked();

  // Flip every toggle.
  await inAppCheckbox.setChecked(!initialInApp);
  await emailCheckbox.setChecked(!initialEmail);
  await startingSoonCheckbox.setChecked(!initialStartingSoon);
  await overdueCheckbox.setChecked(!initialOverdue);
  await dueTodayCheckbox.setChecked(!initialDueToday);
  await page.waitForTimeout(300);

  await page.reload();
  await page.waitForTimeout(500);
  await gotoTab(page, 'Settings');

  await expect(page.locator('#notifInApp')).toHaveJSProperty('checked', !initialInApp);
  await expect(page.locator('#notifEmail')).toHaveJSProperty('checked', !initialEmail);
  await expect(page.locator('#notifStartingSoon')).toHaveJSProperty('checked', !initialStartingSoon);
  await expect(page.locator('#notifOverdue')).toHaveJSProperty('checked', !initialOverdue);
  await expect(page.locator('#notifDueToday')).toHaveJSProperty('checked', !initialDueToday);

  // Restore original settings so this test is idempotent across reruns and
  // doesn't leave other specs with unexpected notification state.
  await page.locator('#notifInApp').setChecked(initialInApp);
  await page.locator('#notifEmail').setChecked(initialEmail);
  await page.locator('#notifStartingSoon').setChecked(initialStartingSoon);
  await page.locator('#notifOverdue').setChecked(initialOverdue);
  await page.locator('#notifDueToday').setChecked(initialDueToday);
  await page.waitForTimeout(200);

  expectNoErrors(errors);
});

test('Guided tour: restart from Settings shows overlay and can be dismissed', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Settings');
  await page.getByRole('button', { name: /replay guided tour/i }).click();
  await page.waitForTimeout(400);

  const overlay = page.locator('.guided-tour-overlay');
  await expect(overlay).toBeVisible();

  await page.getByRole('button', { name: 'Close tour' }).click();
  await page.waitForTimeout(300);
  await expect(overlay).toHaveCount(0);

  expectNoErrors(errors);
});
