// Shared helpers for the full-suite Playwright tests (tests/e2e/full-suite/).
// Every spec in this directory should import from here rather than
// duplicating boilerplate, so selector fixes only need to happen once.
import { expect } from '@playwright/test';
import { CURRENT_VERSION } from '../../../src/changelog.js';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:5183';

export function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// Some specs reload mid-test to check persistence (either a second gotoApp()
// call, or a bare page.reload()/page.goto() the test makes directly) — that
// reload must NOT wipe the data the test just wrote. page.addInitScript
// re-runs its script on EVERY navigation of the page for the rest of its
// lifetime once registered, not just the first, so a Node-side "have we
// called this already" guard around the registration call isn't enough —
// the guard has to live INSIDE the injected script itself. sessionStorage
// (unlike the taskflow:-namespaced localStorage this script wipes) isn't
// touched by the wipe and is genuinely per-tab: it survives a reload but
// starts empty on a brand new page/context, which is exactly the
// "first load of this test" vs. "this page got reloaded mid-test"
// distinction needed here.
const CLEARED_FLAG = 'taskflow:e2e-cleared-once';

// The first gotoApp() call for a given page wipes TaskFlow's own
// localStorage namespace before the app boots. Without this, one test's
// completed/deleted tasks, active filter, or widget toggles leak into the
// next test sharing the worker's browser context, since the app only seeds
// mock data when a key is absent (see persistence.js). Clearing via
// addInitScript (not after goto) runs before the app's own boot-time reads,
// avoiding a race with it. Scoped to the `taskflow:` prefix rather than a
// blanket localStorage.clear() so it doesn't touch anything unrelated
// Playwright/the browser may have set.
//
// The clear also pre-seeds two "already seen" flags so first-run overlays
// never open during ordinary test setup — a wiped profile is otherwise
// indistinguishable from a brand-new user:
//   - `tutorial-seen: true` (App.jsx's usePersistedState('tutorial-seen',
//     false)) — the guided tour overlay (`.guided-tour-overlay`, z-index
//     above ordinary content) can swallow the very next click a test makes,
//     hanging it until its 30s timeout. The one spec that exercises the tour
//     itself (settings-and-backups.spec.js's "Guided tour: restart from
//     Settings") re-opens it explicitly via Settings, so pre-marking it seen
//     doesn't affect that coverage.
//   - `lastSeenChangelogVersion: CURRENT_VERSION` — otherwise the "What's
//     New" modal pops on every fresh/reloaded page (App.jsx compares
//     `!== CURRENT_VERSION`), and a test that calls `page.reload()` directly
//     (bypassing gotoApp's own dismiss-click, which only runs here) is left
//     with a `.modal-overlay` blocking every subsequent click. The
//     "Changelog modal (Versions)" spec opens it explicitly from Settings,
//     unaffected by this.
export async function gotoApp(page) {
  // Registering the same init script on every gotoApp() call (rather than
  // once per page) is harmless — Playwright just runs each registered
  // script in order before every navigation, and the sessionStorage guard
  // inside makes every run after the first a no-op.
  await page.addInitScript(
    ({ currentVersion, clearedFlag }) => {
      try {
        if (window.sessionStorage.getItem(clearedFlag)) return;
        window.sessionStorage.setItem(clearedFlag, '1');
        const keysToRemove = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('taskflow:')) keysToRemove.push(k);
        }
        keysToRemove.forEach((k) => window.localStorage.removeItem(k));
        window.localStorage.setItem('taskflow:v1:tutorial-seen', 'true');
        window.localStorage.setItem('taskflow:v1:lastSeenChangelogVersion', JSON.stringify(currentVersion));
      } catch {
        /* ignore */
      }
    },
    { currentVersion: CURRENT_VERSION, clearedFlag: CLEARED_FLAG }
  );
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

// Every window.confirm() in the app was replaced by an in-app modal
// (ConfirmContext.jsx/ConfirmModal.jsx) so a browser silently blocking
// window.confirm (seen in the wild in Firefox) can no longer make every
// destructive-action button do nothing with zero feedback. Tests that used
// to pre-register `page.once('dialog', ...)` before triggering a
// window.confirm now await this modal instead — it renders as
// `role="dialog"` with a fixed accessible name of "Confirm" (or "Confirm
// destructive action" for the danger-styled variant), body text in
// `.confirm-modal-message`, and Confirm/Cancel buttons labeled per call site
// (e.g. "Delete", "Restore", "Disconnect" — see each call site's
// `confirmLabel` option).
export function getConfirmModal(page) {
  return page.getByRole('dialog', { name: /^Confirm/ });
}

/** Waits for the shared confirm modal, optionally checks its message, then clicks Confirm/Cancel. */
export async function resolveConfirmModal(page, { expectMessage, confirmLabel, accept = true } = {}) {
  const dialog = getConfirmModal(page);
  await expect(dialog).toBeVisible();
  if (expectMessage) await expect(dialog.locator('.confirm-modal-message')).toContainText(expectMessage);
  if (accept) {
    await (confirmLabel ? dialog.getByRole('button', { name: confirmLabel, exact: true }) : dialog.getByRole('button').last()).click();
  } else {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await expect(dialog).toHaveCount(0);
}

export function expectNoErrors(errors) {
  expect(errors, errors.join('\n')).toEqual([]);
}
