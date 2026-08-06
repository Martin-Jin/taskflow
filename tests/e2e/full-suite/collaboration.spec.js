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
 * clicking, since a concurrency bug found by clicking is found late.
 *
 * PHASE 2 (share links) — WHY A REAL TWO-BROWSER JOIN TEST STILL DOESN'T
 * BELONG HERE. Generating a link, and completing a join, both require a live
 * Cloudflare Worker call (token resolution, custom-token minting) and a real
 * Firestore project — neither exists in this suite's headless, localStorage-
 * only environment (see the file header above). That gap is covered instead
 * by: the Worker's own logic being unit-testable in isolation
 * (shareLinkLogic.js mirrors sharedProjectAccess.js's pure functions), the
 * firestore.rules emulator suite (`npm run test:rules`) for the actual
 * authorization decisions, and tests/unit/joinFlow.test.js for the sequencing
 * (already-a-member short-circuit, upgrade-not-downgrade, the anonymous name
 * prompt/cache). What's left, and IS covered below: the parts of the join
 * landing that run regardless of whether the token turns out to be valid —
 * URL handling and not crashing for a signed-out visitor — plus the Share
 * dialog's own reachability, extending the Phase 1 pattern above.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, trackConsoleErrors, expectNoErrors, BASE_URL } from './helpers.js';

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

test.describe('Share link landing (?join=) — reachable-without-Firebase slice', () => {
  test('a bogus token resolves to a failure state, not a crash or a stuck spinner', async ({ page }) => {
    // This token can't resolve to anything real, but the flow must still run
    // to completion: sign in anonymously, attempt to reach the Worker, and
    // land on SOME rendered failure — never an unhandled rejection or an
    // infinite busy state. Deliberately not asserting WHICH failure message,
    // or that the console stays clean: whether this environment's Firebase
    // project allows an anonymous sign-in from this origin determines whether
    // the outcome is "invalid_token" (fully resolved, token unknown) or an
    // auth/network error (couldn't even sign in) — both are equally valid,
    // tested outcomes (see joinFlow.test.js/useJoinFlow's catch block, which
    // deliberately logs this class of failure, same as every other caught-
    // and-surfaced error in this app). What must hold regardless of which
    // branch this environment takes is: something renders, and it's
    // dismissable — so this test does NOT use trackConsoleErrors/
    // expectNoErrors, unlike its siblings.
    await page.goto(`${BASE_URL}/?join=e2e-test-invalid-token-000000`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    // Busy states ("Opening…"/"Joining…") must resolve into an actionable one
    // with a "Continue to TaskFlow" button — not linger forever.
    await expect(page.getByRole('button', { name: /continue to taskflow/i })).toBeVisible({ timeout: 15000 });

    // The escape hatch must actually work: dismissing lands back on a normal,
    // usable app rather than leaving the visitor stuck mid-flow. This is also
    // the regression check for the guided tour's overlay (z-index: 1000)
    // intercepting this click — JoinProjectModal's overlay must render above
    // it (see .join-modal-overlay in global.css).
    await page.getByRole('button', { name: /continue to taskflow/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the token is stripped from the URL immediately, before resolution finishes', async ({ page }) => {
    // A share token is a secret; it must not linger in the address bar or
    // survive a reload regardless of whether the join succeeds — see
    // useJoinFlow's header for why this happens before the network call, not
    // after.
    await page.goto(`${BASE_URL}/?join=e2e-test-strip-me-000000`);
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });

    await expect
      .poll(() => new URL(page.url()).searchParams.has('join'), { timeout: 3000 })
      .toBe(false);
  });

  test('a page load with no join param renders nothing from the join flow', async ({ page }) => {
    // The overwhelmingly common case — confirms the modal truly costs nothing
    // when there's no token, rather than e.g. flashing briefly.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    await expect(page.getByRole('dialog', { name: /join|shared project/i })).toHaveCount(0);
    expectNoErrors(errors);
  });
});
