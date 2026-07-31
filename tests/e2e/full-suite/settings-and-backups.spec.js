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
