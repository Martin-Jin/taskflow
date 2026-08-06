/**
 * Collaborative Projects — Phase 1 (live multi-writer sync).
 *
 * WHAT THIS SUITE CAN AND CANNOT COVER. The app runs fully local against
 * localStorage with seeded mock data whenever nobody is signed in (see
 * helpers.js / CLAUDE.md), and sharing a project deliberately requires a real
 * signed-in, non-anonymous account — firestore.rules refuses to let an
 * anonymous user own a shared project. So these tests cover the parts that are
 * reachable without Firebase credentials:
 *
 *   - the Share action is present and reachable on BOTH desktop and mobile,
 *     which is where the wiring is easiest to get wrong (mobile folds project
 *     actions into the filter popover rather than rendering the "⋯" menu);
 *   - it is offered for a real project and refuses gracefully when signed out;
 *   - nothing about a personal project changed — no presence chrome, no
 *     stray "shared" state on a board nobody has shared.
 *
 * The multi-writer merge behaviour itself is covered by unit tests
 * (tests/unit/sharedTaskSync.test.js), deliberately: the spec calls for the
 * conflict/race decisions to be tested as pure functions rather than found by
 * clicking, since a concurrency bug found by clicking is found late. Phase 2
 * adds the join flow, at which point a two-browser-context test becomes
 * possible and belongs here.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, trackConsoleErrors, expectNoErrors } from './helpers.js';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Same idiom as views.spec.js — the project switcher is a SelectMenu of role="option" items. */
async function switchToProject(page, name) {
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('option', { name, exact: true }).click();
  await page.waitForTimeout(300);
}

test.describe('Sharing a project — reachability', () => {
  test('desktop: the sidebar project menu offers "Share project"', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    await page.getByRole('button', { name: /^Actions for / }).first().click();
    await expect(page.getByRole('menuitem', { name: 'Share project' })).toBeVisible();

    await page.keyboard.press('Escape');
    expectNoErrors(errors);
  });

  test('desktop: the List view project header offers it too', async ({ page }) => {
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');

    await page.getByRole('main').getByRole('button', { name: 'Actions for Work' }).click();
    await expect(page.getByRole('menuitem', { name: 'Share project' })).toBeVisible();
  });

  test('mobile: it is reachable through the filter popover, which replaces the "⋯" menu', async ({ page }) => {
    // Mobile has no sidebar and hides the ProjectActionsMenu trigger, folding
    // the same actions into ViewFilterMenu instead (see TaskListPanel's
    // `projectActions` prop). Without threading sharing through that path it
    // would be desktop-only, which the standing mobile rule forbids.
    const errors = trackConsoleErrors(page);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');

    await page.getByRole('button', { name: /view.*filter/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('menuitem', { name: 'Share project' })).toBeVisible();

    expectNoErrors(errors);
  });

  test('mobile: no project actions section while "All Tasks" is selected', async ({ page }) => {
    // "All Tasks" isn't a project, so there's nothing to share or rename —
    // the section is absent rather than showing dead controls.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    await page.getByRole('button', { name: /view.*filter/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('menuitem', { name: 'Share project' })).toHaveCount(0);
  });
});

test.describe('Sharing a project — signed out', () => {
  test('asks the user to sign in rather than failing silently or crashing', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');

    await page.getByRole('main').getByRole('button', { name: 'Actions for Work' }).click();
    await page.getByRole('menuitem', { name: 'Share project' }).click();
    await page.waitForTimeout(400);

    await expect(page.getByText(/sign in to share a project/i)).toBeVisible();
    // The project must NOT have been marked shared locally on a failed attempt.
    await page.getByRole('main').getByRole('button', { name: 'Actions for Work' }).click();
    await expect(page.getByRole('menuitem', { name: 'Share project' })).toBeVisible();

    expectNoErrors(errors);
  });
});

test.describe('Personal projects are untouched', () => {
  test('no presence avatars render for a project nobody has shared', async ({ page }) => {
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');

    await expect(page.locator('.presence-avatars')).toHaveCount(0);
  });

  test('the task list still works normally with sharing wired in', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');

    // Mock data's Work project — if the sharing wiring broke ordinary
    // rendering, this is where it would show up.
    await expect(page.getByText('Finish Q3 investor deck')).toBeVisible();
    expectNoErrors(errors);
  });
});
