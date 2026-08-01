// Coverage for the "why couldn't this be scheduled" conflict-detail flow —
// see algorithms/allocator.js + rebalanceEngine.js (reason-tracking on
// overflow entries) and SchedulingConflictsModal.jsx (the "View details"
// destination off the Re-balance toast). Exercises the dependency-blocked
// path specifically since it's fully driveable through the existing task UI
// (see tasks-and-smart-parse.spec.js's dependency-cycle tests for the same
// pattern) without needing a second modal (calendar event creation) just to
// reach the fixed-time-conflict path, which is already covered at the unit
// level (tests/unit/rebalanceEngine.test.js).
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, openAddTask, trackConsoleErrors, expectNoErrors } from './helpers';

const RUN_ID = Date.now();

async function submitAddTask(page) {
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(400);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

test.describe('Scheduling conflict details', () => {
  test('View details on the Re-balance toast shows why a dependency-blocked task could not be scheduled', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const blockerTitle = `E2E Conflict Blocker ${RUN_ID}`;
    const waiterTitle = `E2E Conflict Waiter ${RUN_ID}`;
    const today = todayIso();

    // Blocker task, due today, not yet completed.
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(blockerTitle);
    let pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill(today);
    await pills.nth(0).click();
    await submitAddTask(page);

    // Waiter task, due today, depends on the blocker via More options.
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(waiterTitle);
    pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill(today);
    await pills.nth(0).click();
    await pills.nth(3).click(); // More options
    const depField = page.locator('.detail-field', { hasText: 'Depends on' });
    await expect(depField).toBeVisible();
    await depField.locator('input[type="text"]').fill('E2E Conflict Blocker');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: blockerTitle, exact: true }).click();
    await submitAddTask(page);

    // Sanity check the waiter really is due today and depends on the blocker
    // before relying on the rebalance to surface it as a conflict.
    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill(waiterTitle);
    await page.waitForTimeout(300);
    await page.getByText(waiterTitle, { exact: false }).first().click();
    await page.waitForTimeout(300);
    await expect(page.getByText(/Waiting on:.*E2E Conflict Blocker/)).toBeVisible();
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await expect(dueDateInput).toHaveValue(today);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Trigger a rebalance from the Calendar tab and open the conflict details.
    await gotoTab(page, 'Calendar');
    await page.getByRole('button', { name: 'Re-balance schedule' }).click();
    await page.waitForTimeout(500);

    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    const viewDetails = toast.getByRole('button', { name: 'View details' });
    await expect(viewDetails).toBeVisible();
    await viewDetails.click();

    const modal = page.getByRole('dialog', { name: 'Scheduling conflicts' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(waiterTitle)).toBeVisible();
    // The blocker itself may also appear in the list (e.g. its own capacity
    // reason) — assert specifically on the waiter's "waiting on the blocker"
    // explanation, not just any mention of the blocker's title.
    await expect(modal.getByText(new RegExp(`Waiting on.*${blockerTitle}`))).toBeVisible();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });
});
