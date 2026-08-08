// Tracked regression coverage for:
//   1. TimerWidget / TimerContext — start/pause/resume/stop a per-task
//      Pomodoro timer, and multiple concurrent timers (TimerContext keys
//      timers by taskId, so starting one never affects another — see its
//      file header).
//   2. AI Quick Add (AIQuickAddModal / AIQuickAddGuideModal /
//      aiQuickAddService.js) — entry point gating, BYOK (bring-your-own-key)
//      validation, the guide modal, and attaching/removing multiple
//      images/PDFs.
//   3. AIPlanConfirmModal / SmartParseGuideModal — reachability without
//      crashing (AIPlanConfirmModal only renders after a real AI Quick Add
//      call succeeds, so it's noted/skipped rather than exercised against a
//      live backend — see the comment on that test).
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, openAddTask, closeAnyModal, trackConsoleErrors, expectNoErrors } from './helpers.js';

// localStorage keys AI Quick Add reads via getStoredApiKey (see
// aiQuickAddService.js's AI_KEY_STORAGE) — namespaced under persistence.js's
// "taskflow:v1:" prefix.
const AI_KEY_LOCALSTORAGE = {
  anthropic: 'taskflow:v1:aiAnthropicApiKey',
  gemini: 'taskflow:v1:aiGeminiApiKey',
};

async function clearStoredAiKeys(page) {
  await page.evaluate((keys) => {
    keys.forEach((k) => window.localStorage.removeItem(k));
  }, Object.values(AI_KEY_LOCALSTORAGE));
}

async function createTask(page, title) {
  await openAddTask(page);
  await page.getByPlaceholder('Task name').fill(title);
  await page.waitForTimeout(300);
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(500);
}

async function openTaskDetail(page, title) {
  await page.getByPlaceholder(/search tasks/i).fill(title);
  await page.waitForTimeout(300);
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.modal-detail')).toBeVisible();
}

test.describe('Timer widget / TimerContext', () => {
  test('start, pause, resume and stop a timer from a task detail view', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const title = `E2E Timer Task ${Date.now()}`;
    await createTask(page, title);

    await openTaskDetail(page, title);

    // No timer yet -> a "Start timer (MM:SS)" button (TaskTimerControl).
    const startBtn = page.getByRole('button', { name: /start timer/i });
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    await page.waitForTimeout(300);

    // Running -> pause button appears in the detail view's timer control.
    const pauseBtn = page.locator('.detail-timer-control').getByRole('button', { name: /pause timer/i });
    await expect(pauseBtn).toBeVisible();

    // Closing the detail modal shouldn't stop the timer — TimerWidget (mounted
    // at the app shell) should keep showing it running.
    await closeAnyModal(page);
    await expect(page.locator('.timer-widget')).toBeVisible();
    await expect(page.locator('.timer-widget')).toContainText(/1 timer running/i);
    await expect(page.locator('.timer-widget-row-title', { hasText: title })).toBeVisible();

    // Pause via the widget itself, then resume.
    const widgetPauseBtn = page.locator('.timer-widget-row', { hasText: title }).getByRole('button', { name: /pause timer/i });
    await widgetPauseBtn.click();
    await page.waitForTimeout(200);
    const widgetResumeBtn = page.locator('.timer-widget-row', { hasText: title }).getByRole('button', { name: /resume timer/i });
    await expect(widgetResumeBtn).toBeVisible();
    await widgetResumeBtn.click();
    await page.waitForTimeout(200);
    await expect(page.locator('.timer-widget-row', { hasText: title }).getByRole('button', { name: /pause timer/i })).toBeVisible();

    // Stop it from the widget -> since it was the only active timer, the
    // whole widget unmounts (TimerWidget returns null when activeTimers is empty).
    const widgetStopBtn = page.locator('.timer-widget-row', { hasText: title }).getByRole('button', { name: /stop timer/i });
    await widgetStopBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('.timer-widget')).toHaveCount(0);

    // Re-opening the task's detail view should show "Start timer" again (no
    // timer entry left behind for this task).
    await openTaskDetail(page, title);
    await expect(page.getByRole('button', { name: /start timer/i })).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('two tasks can run timers concurrently — starting one does not affect the other', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const stamp = Date.now();
    const titleA = `E2E Timer Task A ${stamp}`;
    const titleB = `E2E Timer Task B ${stamp}`;
    await createTask(page, titleA);
    await createTask(page, titleB);

    // Start A's timer.
    await openTaskDetail(page, titleA);
    await page.getByRole('button', { name: /start timer/i }).click();
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await expect(page.locator('.timer-widget')).toContainText(/1 timer running/i);

    // Start B's timer — TimerContext keys timers by taskId, so this should
    // add a second concurrent timer rather than replacing/blocking A's.
    await openTaskDetail(page, titleB);
    await page.getByRole('button', { name: /start timer/i }).click();
    await page.waitForTimeout(300);
    await closeAnyModal(page);

    await expect(page.locator('.timer-widget')).toContainText(/2 timers running/i);
    await expect(page.locator('.timer-widget-row-title', { hasText: titleA })).toBeVisible();
    await expect(page.locator('.timer-widget-row-title', { hasText: titleB })).toBeVisible();

    // A should still be running (not paused/stopped by B starting).
    await expect(page.locator('.timer-widget-row', { hasText: titleA }).getByRole('button', { name: /pause timer/i })).toBeVisible();

    // Stop A; B should keep running and the widget should drop to "1 timer running".
    await page.locator('.timer-widget-row', { hasText: titleA }).getByRole('button', { name: /stop timer/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.timer-widget')).toContainText(/1 timer running/i);
    await expect(page.locator('.timer-widget-row-title', { hasText: titleB })).toBeVisible();
    await expect(page.locator('.timer-widget-row-title', { hasText: titleA })).toHaveCount(0);

    // Clean up B's timer too.
    await page.locator('.timer-widget-row', { hasText: titleB }).getByRole('button', { name: /stop timer/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.timer-widget')).toHaveCount(0);

    expectNoErrors(errors);
  });
});

test.describe('AI Quick Add', () => {
  test('entry point is gated on BYOK key presence, then opens and its guide modal works', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await clearStoredAiKeys(page);
    await gotoTab(page, 'Tasks');

    // The "AI Quick Add" mini-FAB only renders at all when
    // VITE_AI_QUICKADD_WORKER_URL is configured (isAIQuickAddConfigured) —
    // see AddTaskFabGroup.jsx. If it's not configured in this environment,
    // there's nothing further to exercise; skip gracefully like the existing
    // manual smoke test does.
    // The persistent toggle FAB carries a stable data-tour attribute — its
    // accessible name flips between "Add task"/"Close" as it (de)expands, and
    // "Add task" is otherwise ambiguous with the mini-FAB of the same name
    // once expanded, so anchor on that instead of the role name.
    const mainToggle = page.locator('[data-tour="add-task"]');
    await expect(mainToggle).toBeVisible();
    await mainToggle.click(); // expands the speed-dial (AI Quick Add + Add task mini-FABs)
    await page.waitForTimeout(200);

    const aiFab = page.getByRole('button', { name: 'AI Quick Add', exact: true });
    const aiConfigured = await aiFab.isVisible({ timeout: 1000 }).catch(() => false);
    test.skip(!aiConfigured, 'AI Quick Add is not configured locally (VITE_AI_QUICKADD_WORKER_URL unset) — entry point is intentionally hidden.');

    // BYOK validation, gate 1: with no key at all saved for either provider,
    // clicking the entry point must NOT open the modal — it should block with
    // a toast pointing at Settings instead (see AddTaskFabGroup's
    // handleAIQuickAdd). This is the actual "submit without a key" guard,
    // since the modal's own provider picker later disables any keyless
    // provider outright (SelectMenu `disabled` in AIQuickAddModal.jsx).
    await aiFab.click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog', { name: 'AI Quick Add' })).toHaveCount(0);
    const blockedToast = page.locator('.toast', { hasText: /api key/i });
    await expect(blockedToast).toBeVisible();
    await expect(blockedToast).toContainText(/settings/i);

    // Now simulate a saved (fake, never sent anywhere in this test — no
    // "Plan changes" submit happens) Gemini key so the entry point actually
    // opens the modal.
    await page.evaluate((key) => {
      window.localStorage.setItem(key, JSON.stringify('e2e-fake-test-key'));
    }, AI_KEY_LOCALSTORAGE.gemini);

    // The blocked attempt above doesn't collapse the speed-dial (only a
    // successful open does — see handleAIQuickAdd), so the mini-FAB is still
    // showing; click it again now that a key is present.
    await expect(aiFab).toBeVisible();
    await aiFab.click();
    await page.waitForTimeout(300);

    const modal = page.getByRole('dialog', { name: 'AI Quick Add', exact: true });
    await expect(modal).toBeVisible();

    // Open the guide modal from the "?" help icon and confirm it renders.
    await modal.getByRole('button', { name: /how does this work/i }).click();
    await page.waitForTimeout(300);
    const guide = page.getByRole('dialog', { name: 'AI Quick Add guide' });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(/bring your own key/i);
    await guide.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(200);
    await expect(guide).toHaveCount(0);

    // Close the main modal without submitting — submitting would fire a real
    // network request to the configured worker URL, which this suite
    // deliberately avoids (see class-level comment).
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(200);
    await expect(modal).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('supports attaching multiple images and a PDF, and removing one', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await clearStoredAiKeys(page);
    await gotoTab(page, 'Tasks');

    const mainToggle = page.locator('[data-tour="add-task"]');
    await mainToggle.click();
    await page.waitForTimeout(200);

    const aiFab = page.getByRole('button', { name: 'AI Quick Add', exact: true });
    const aiConfigured = await aiFab.isVisible({ timeout: 1000 }).catch(() => false);
    test.skip(!aiConfigured, 'AI Quick Add is not configured locally (VITE_AI_QUICKADD_WORKER_URL unset) — entry point is intentionally hidden.');

    await page.evaluate((key) => {
      window.localStorage.setItem(key, JSON.stringify('e2e-fake-test-key'));
    }, AI_KEY_LOCALSTORAGE.gemini);
    await aiFab.click();
    await page.waitForTimeout(300);

    const modal = page.getByRole('dialog', { name: 'AI Quick Add', exact: true });
    await expect(modal).toBeVisible();

    // Attach a PNG and a PDF (tiny inline fixtures — content doesn't matter,
    // only that both accepted mime types render a thumbnail/file chip and
    // count toward the same attachment list — see MAX_ATTACHMENTS in
    // AIQuickAddModal.jsx / aiQuickAddService.js / the Worker).
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>', 'utf-8');

    const fileInput = modal.locator('input[type="file"]');
    await fileInput.setInputFiles([
      { name: 'screenshot.png', mimeType: 'image/png', buffer: pngBytes },
      { name: 'flyer.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
    ]);
    await page.waitForTimeout(200);

    const attachmentItems = modal.locator('.ai-quickadd-attachment-item');
    await expect(attachmentItems).toHaveCount(2);
    await expect(modal.locator('.ai-quickadd-attachment-file', { hasText: 'flyer.pdf' })).toBeVisible();

    // Remove the PDF via its own remove button; the image attachment stays.
    await modal.getByRole('button', { name: 'Remove flyer.pdf' }).click();
    await page.waitForTimeout(200);
    await expect(attachmentItems).toHaveCount(1);

    await modal.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(200);
    await expect(modal).toHaveCount(0);

    expectNoErrors(errors);
  });

  // AIPlanConfirmModal (services/aiPlanService.js's resolvePlan output) only
  // ever mounts after AIQuickAddModal's handleSubmit() successfully returns
  // real `operations` from requestAIPlan() — i.e. after a live round-trip to
  // the configured Cloudflare Worker + a real Anthropic/Gemini API key.
  // There's no client-side path to reach it without that live call, and per
  // this suite's scope we don't mock network calls to fake one. Left as an
  // explicit skip rather than silently omitting the scenario — genuinely
  // infeasible headlessly without a live AI backend + a real BYOK key.
  test.skip(
    'AIPlanConfirmModal requires a real AI Quick Add round-trip (live worker + API key) — not exercised without mocking network calls',
    async () => {}
  );
});

test.describe('Smart Parse guide', () => {
  test('opens from Add Task and closes without crashing', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const smartParseBtn = page.getByRole('dialog').getByRole('button', { name: /smart parse:/i });
    await expect(smartParseBtn).toBeVisible();
    await smartParseBtn.click();
    await page.waitForTimeout(300);

    const guide = page.getByRole('dialog', { name: 'Smart parse guide' });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(/due date/i);
    await guide.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(200);
    await expect(guide).toHaveCount(0);

    // The Add Task modal underneath should still be open and unaffected.
    await expect(page.getByPlaceholder('Task name')).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
  });
});
