// Full-suite — bulk multi-select and edit (List + Board): entering selection
// mode, selecting 2+ items, bulk-editing a shared field, and bulk-deleting
// with confirmation. See helpers.js for shared setup, and CLAUDE.md's
// Testing section for this suite's conventions.
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, trackConsoleErrors, expectNoErrors, resolveConfirmModal } from './helpers';

test.describe('Bulk multi-select', () => {
  test('List view: select two tasks, bulk-set priority, then bulk-delete', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    // "All Tasks" (the default view) lists every seeded task — enter
    // selection mode via the toolbar's own toggle.
    await page.getByRole('button', { name: /^select$/i }).click();
    await expect(page.getByRole('button', { name: /cancel select/i })).toBeVisible();

    // Select two known seeded tasks by their title text within a row.
    const row1 = page.locator('.task-row', { hasText: 'Finish Q3 investor deck' }).first();
    const row2 = page.locator('.task-row', { hasText: 'Refactor auth module' }).first();
    await row1.click();
    await row2.click();

    // The bulk action bar appears showing the selection count.
    await expect(page.locator('.bulk-action-bar')).toBeVisible();
    await expect(page.locator('.bulk-action-bar-count')).toHaveText('2 selected');

    // Bulk-set priority to "Urgent" via the priority field's popover.
    await page.locator('.bulk-action-bar').getByTitle('Set priority').click();
    await page.locator('.bulk-action-bar-popover select').selectOption('urgent');
    await page.waitForTimeout(300);

    // Both rows now show the urgent badge.
    await expect(row1.locator('.badge.urgent')).toBeVisible();
    await expect(row2.locator('.badge.urgent')).toBeVisible();

    // Bulk-delete the same two selected tasks, confirming via the shared
    // confirm dialog (see ConfirmContext/BoardView's handleDeleteColumn
    // precedent this feature follows).
    await page.locator('.bulk-action-bar').getByTitle('Delete selected').click();
    await resolveConfirmModal(page, { expectMessage: '2 tasks', confirmLabel: 'Delete' });
    await page.waitForTimeout(300);

    await expect(page.locator('.task-row', { hasText: 'Finish Q3 investor deck' })).toHaveCount(0);
    await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).toHaveCount(0);

    // Selection mode auto-exits after the delete batch completes.
    await expect(page.locator('.bulk-action-bar')).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('List view: Cancel exits selection mode without applying anything', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    await page.getByRole('button', { name: /^select$/i }).click();
    const row = page.locator('.task-row', { hasText: 'Plan Q4 roadmap' }).first();
    await row.click();
    await expect(page.locator('.bulk-action-bar-count')).toHaveText('1 selected');

    await page.locator('.bulk-action-bar').getByLabel('Cancel selection').click();
    await expect(page.locator('.bulk-action-bar')).toHaveCount(0);
    // The task itself is untouched and selection-mode checkboxes are gone —
    // rows go back to their normal click-to-open behavior.
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: /^select$/i })).toBeVisible();

    expectNoErrors(errors);
  });

  test('Board view: select two cards across columns and bulk-set due date', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    // Board view is only offered for a real project, not "All Tasks"/"Inbox"
    // (see TaskListPanel's isPseudoProject filter on viewOptions) — switch to
    // the seeded "Work" project first.
    await page.getByRole('button', { name: 'Switch project' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('option', { name: 'Work', exact: true }).click();
    await page.waitForTimeout(300);

    // Switch to Board view via the view/filter menu.
    await page.getByRole('button', { name: /change view or filter|view, filter, and project actions/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await page.waitForTimeout(400);

    // Board has its own independent Select toggle, rendered in the same
    // shared toolbar row as List's (see TaskListPanel's boardSelect).
    await page.getByRole('button', { name: /^select$/i }).click();
    await expect(page.getByRole('button', { name: /cancel select/i })).toBeVisible();

    const card1 = page.locator('.board-card', { hasText: 'Finish Q3 investor deck' }).first();
    await card1.click();
    await expect(page.locator('.bulk-action-bar-count')).toHaveText('1 selected');

    // Bulk-set a due date via the calendar-icon field.
    await page.locator('.bulk-action-bar').getByTitle('Set due date').click();
    const dateInput = page.locator('.bulk-action-bar-popover input[type="date"]');
    await dateInput.fill('2026-09-01');
    await page.waitForTimeout(300);

    // Applying a field commits immediately but does NOT exit selection mode
    // (only Cancel/bulk-delete do) — the bar stays open with the same count,
    // and the card's own due-date text updates to reflect the edit.
    await expect(page.locator('.bulk-action-bar-count')).toHaveText('1 selected');
    await expect(card1).toContainText('Sep 1');

    await page.locator('.bulk-action-bar').getByLabel('Cancel selection').click();
    await expect(page.locator('.bulk-action-bar')).toHaveCount(0);

    expectNoErrors(errors);
  });
});
