// Shared helpers for the full-suite Playwright tests (tests/e2e/full-suite/).
// Every spec in this directory should import from here rather than
// duplicating boilerplate, so selector fixes only need to happen once.
import { expect } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:5183';

export function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

export async function gotoApp(page) {
  await page.goto(BASE_URL);
  const skipTour = page.getByRole('button', { name: /skip|got it|close/i }).first();
  if (await skipTour.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipTour.click().catch(() => {});
  }
}

export async function gotoTab(page, tabName) {
  await page.getByRole('button', { name: tabName, exact: true }).click();
  await page.waitForTimeout(300);
}

export async function openAddTask(page) {
  await gotoTab(page, 'Tasks');
  // With AI Quick Add configured (true for this repo's local .env),
  // AddTaskFabGroup turns "Add task" into a two-mini-FAB speed dial — the
  // first click only expands it, a second click on the now-visible "Add
  // task" mini-FAB actually opens the modal. Without AI Quick Add configured
  // the single button opens the modal directly on the first click.
  await page.getByRole('button', { name: /^add task$/i }).click();
  const titleInput = page.getByPlaceholder('Task name');
  if (!(await titleInput.isVisible({ timeout: 1000 }).catch(() => false))) {
    await page.getByRole('button', { name: /^add task$/i }).click();
  }
  await expect(titleInput).toBeVisible();
}

export async function closeAnyModal(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

export function expectNoErrors(errors) {
  expect(errors, errors.join('\n')).toEqual([]);
}
