// Full-suite regression coverage for task CRUD, sub-tasks, dependencies,
// labels, recurrence, smart parse, and task-form validation edge cases.
// See AddTaskModal.jsx / TaskDetailModal.jsx / smartParse.js / recurrence.js /
// dependencyUtils.js for the behaviors asserted below.
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  gotoTab,
  openAddTask,
  closeAnyModal,
  trackConsoleErrors,
  expectNoErrors,
  chooseSelectMenuOption,
  selectMenuLabel,
} from './helpers';

// Unique-ish suffix per test run so repeated runs against the same
// localStorage-backed app don't collide with tasks left over from a
// previous run.
const RUN_ID = Date.now();

async function submitAddTask(page) {
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(400);
}

async function searchAndOpen(page, title) {
  await gotoTab(page, 'Tasks');
  const search = page.getByPlaceholder(/search tasks/i);
  await search.fill('');
  await search.fill(title);
  await page.waitForTimeout(300);
  await page.getByText(title, { exact: false }).first().click();
  await page.waitForTimeout(300);
}

async function clearSearch(page) {
  const search = page.getByPlaceholder(/search tasks/i);
  await search.fill('').catch(() => {});
}

// Local-time "today" as YYYY-MM-DD, matching the app's own toISODate
// (dateUtils.js) — Date#toISOString() is UTC and can disagree with the app's
// local-time "today" near a UTC day boundary, which would make a "due today"
// assertion flaky/wrong depending on the machine's time zone.
function todayIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Drags one `.task-row` onto another via native HTML5 DnD (TaskListPanel's
// rows are `draggable` + onDragStart/onDrop — see its SUB-TASK DRAG note).
// Chromium fires its real drag machinery off plain mouse events as long as the
// move happens in several steps past the drag threshold. Releases at the
// target row's vertical centre, since a drop grazing a row's top/bottom edge
// deliberately doesn't arm (see useReparentDrag's EDGE_DEAD_ZONE_PX).
async function rowDnd(page, source, target) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2 + 12, { steps: 5 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// Same gesture as rowDnd, but released on the list's own empty background
// (below the last row) instead of on another row — the "unparent" drop
// target (see hooks/useReparentDrag.js's UNPARENT section), the inverse of
// dragging a row onto another row to set its parent.
async function rowDndToBackground(page, source) {
  const sourceBox = await source.boundingBox();
  const rowsBox = await page.locator('.tasklist-rows').boundingBox();
  // `.tasklist-rows` reserves bottom padding specifically so there's always
  // some empty background to release on (see its own CSS comment) — aim just
  // inside that padding, well clear of the last row's own box.
  const dropY = rowsBox.y + rowsBox.height - 4;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2 + 12, { steps: 5 });
  await page.mouse.move(rowsBox.x + rowsBox.width / 2, dropY, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('Task CRUD', () => {
  test('creates a task with full metadata, edits it, then deletes it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E CRUD Task ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);

    // Description.
    await page.getByPlaceholder('Description (optional)').fill('E2E description text');

    // Due date pill (1st pill).
    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    const dateInput = page.locator('.addtask-pill-panel input[type="date"]');
    await dateInput.fill('2026-08-15');
    await pills.nth(0).click(); // close panel

    // Priority pill (2nd pill) -> urgent (p1).
    await pills.nth(1).click();
    await chooseSelectMenuOption(page, 'Priority', 'Urgent');
    await pills.nth(1).click();

    // Labels pill (3rd pill) -> create + select a new label.
    await pills.nth(2).click();
    const labelInput = page.locator('.addtask-pill-panel input[type="text"]').first();
    await labelInput.fill(`e2e-label-${RUN_ID}`);
    await page.waitForTimeout(200);
    const createLabelOption = page.getByRole('button', { name: new RegExp(`Create.*e2e-label-${RUN_ID}`) });
    if (await createLabelOption.isVisible({ timeout: 1000 }).catch(() => false)) {
      await createLabelOption.click();
    }
    await pills.nth(2).click();

    // Project (footer SelectMenu) -> Work.
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('option', { name: 'Work', exact: true }).click();

    // More options -> Section + Estimated time.
    await pills.nth(3).click();
    const sectionPicker = page.locator('.addtask-more-panel').getByRole('button', { name: 'Section', exact: true });
    if (await sectionPicker.isVisible({ timeout: 1000 }).catch(() => false)) {
      await chooseSelectMenuOption(page, 'Section', 'Planning').catch(() => {});
    }
    const durationInput = page.locator('.smart-duration-input');
    await durationInput.click();
    await durationInput.fill('2h');
    await durationInput.blur();

    await submitAddTask(page);

    // Verify it was created and shows up in search.
    await searchAndOpen(page, title);
    await expect(page.getByRole('dialog')).toBeVisible();
    // Project/Priority/Section are all SelectMenu (a button + portaled
    // listbox, not a native <select>) — read the displayed label instead of
    // a form-control value.
    await expect.poll(() => selectMenuLabel(page, 'Project')).toBe('Work');
    await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('Urgent');
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await expect(dueDateInput).toHaveValue('2026-08-15');
    await expect(page.locator('.detail-notes-textarea')).toHaveValue('E2E description text');
    await expect(page.locator('.chip.chip-label', { hasText: `e2e-label-${RUN_ID}` })).toBeVisible();

    // Edit: lower priority to low, wait for sidebar auto-save (debounced 500ms).
    await chooseSelectMenuOption(page, 'Priority', 'Low');
    await page.waitForTimeout(700);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Re-open and verify the edit persisted.
    await searchAndOpen(page, title);
    await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('Low');

    // Delete via the "..." menu.
    await page.getByRole('button', { name: /more actions/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page.waitForTimeout(300);

    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    await expect(page.getByText(title, { exact: false })).toHaveCount(0);

    expectNoErrors(errors);
  });
});

test.describe('Sub-tasks', () => {
  test('Escape cancels the add-sub-task row without closing the task modal', async ({ page }) => {
    /* Escape used to close TaskDetailModal outright here, taking the typed
       sub-task title with it — the add row's own handler never ran, because the
       modal claimed the keypress first. Now the innermost surface wins, so the
       first press collapses just this row (see src/hooks/useEscapeLayer.js). */
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Subtask Escape ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await expect(page.locator('.subtask-add-wrap')).toBeVisible();
    await page.keyboard.type('abandoned child');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // The row is gone, the modal is not, and nothing was saved.
    await expect(page.locator('.subtask-add-wrap')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(addSubtaskBtn).toBeVisible();
    await expect(page.getByText('abandoned child')).toHaveCount(0);

    // Only now does Escape reach the modal.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('adds a sub-task, completes it, and the parent reflects the count', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Subtask Parent ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await expect(addSubtaskBtn).toBeVisible();
    await addSubtaskBtn.click();
    await page.keyboard.type('E2E child task');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    await expect(page.getByText('Sub-tasks (0/1)')).toBeVisible();

    const subtaskCheckbox = page.locator('.subtask-row', { hasText: 'E2E child task' }).locator('input[type="checkbox"]');
    await subtaskCheckbox.click();
    await page.waitForTimeout(300);

    await expect(page.getByText('Sub-tasks (1/1)')).toBeVisible();
    await expect(subtaskCheckbox).toBeChecked();

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('dragging one list row onto another makes it a sub-task, dropping it back on itself is a no-op, and dragging it onto empty background unparents it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // Two fresh top-level tasks with a shared prefix, so they're easy to
    // isolate from mock data's own rows via the search box.
    const prefix = `E2E Drag ${RUN_ID}`;
    for (const suffix of ['Parent', 'Child']) {
      await openAddTask(page);
      await page.getByPlaceholder('Task name').fill(`${prefix} ${suffix}`);
      await submitAddTask(page);
    }

    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill(prefix);
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape'); // dismiss the search dropdown so it can't cover the rows

    const parentRow = page.locator('.task-row', { hasText: `${prefix} Parent` }).first();
    const childRow = page.locator('.task-row', { hasText: `${prefix} Child` }).first();
    await expect(parentRow).toBeVisible();
    await expect(childRow).toBeVisible();

    // Dropping a row on ITSELF is never a valid reparent (getIneligibleParentIds
    // includes the dragged task) — no nesting, no crash.
    await rowDnd(page, childRow, childRow);
    await expect(page.locator('.task-row-child', { hasText: `${prefix} Child` })).toHaveCount(0);

    await rowDnd(page, childRow, parentRow);

    // The child is now nested (a `.task-row-child`, indented under its parent)
    // and the parent shows the sub-task count badge.
    await expect(page.locator('.task-row-child', { hasText: `${prefix} Child` })).toBeVisible();
    await expect(parentRow.locator('.task-row-subtask-count')).toContainText('1');

    // Persisted, not just a visual nesting: the parent's detail modal lists it.
    await parentRow.click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Sub-tasks (0/1)')).toBeVisible();
    await closeAnyModal(page);

    // The reverse drop would be a cycle (a task can't become a child of its own
    // sub-task) — getIneligibleParentIds rules it out, so the target never arms
    // and the drop is a no-op rather than corrupting the hierarchy.
    const nestedChildRow = page.locator('.task-row-child', { hasText: `${prefix} Child` }).first();
    await rowDnd(page, parentRow, nestedChildRow);
    await expect(page.locator('.task-row-child', { hasText: `${prefix} Child` })).toBeVisible();
    await expect(page.locator('.task-row.is-reparent-target')).toHaveCount(0);
    await expect(page.locator('.task-row', { hasText: `${prefix} Parent` }).first()).not.toHaveClass(/task-row-child/);

    // Dragging the (still nested) child row back out onto the list's own
    // empty background clears its parent — the inverse gesture (see
    // hooks/useReparentDrag.js's UNPARENT section).
    await rowDndToBackground(page, nestedChildRow);
    await expect(page.locator('.task-row-child', { hasText: `${prefix} Child` })).toHaveCount(0);
    await expect(parentRow.locator('.task-row-subtask-count')).toHaveCount(0);
    // Persisted: the child is a plain top-level row now, no parent link left
    // in its own detail modal's hierarchy label (see TaskDetailModal's
    // HIERARCHY LABEL note — `.detail-hierarchy-link` only renders when the
    // open task still has a parent).
    await page.locator('.task-row', { hasText: `${prefix} Child` }).first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('.detail-hierarchy-link')).toHaveCount(0);
    await closeAnyModal(page);

    await clearSearch(page);
    expectNoErrors(errors);
  });

  test('"Apply to all sub-tasks" only appears for appliable edits, hides right after a click, and reappears on the next edit', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Apply All Parent ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await page.keyboard.type('E2E apply-all child');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const applyAllBtn = page.getByRole('button', { name: /apply to all sub-tasks/i });
    await expect(applyAllBtn).not.toBeVisible();

    // Editing the parent's own title/description is never appliable to
    // sub-tasks (a shared title would collide) — it must not surface the
    // button, even though it does dirty the modal's Save/Cancel row.
    const titleInput = page.locator('.smart-title-input').first();
    await titleInput.fill(`${title} (edited)`);
    await page.waitForTimeout(200);
    await expect(applyAllBtn).not.toBeVisible();
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(200);

    // Turning on recurrence alone isn't appliable either — recurrence now
    // syncs to sub-tasks automatically (computeRecurrenceSyncUpdates), so a
    // manual copy step would be redundant and shouldn't show the button.
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await dueDateInput.fill('2026-08-20');
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /does not repeat/i }).click();
    await page.waitForTimeout(200);
    // The due date edit just above IS appliable, so the button is visible —
    // confirm recurrence alone didn't need to contribute to that.
    await expect(applyAllBtn).toBeVisible();

    // An appliable field (priority) surfaces/keeps the button.
    await chooseSelectMenuOption(page, 'Priority', 'Urgent');
    await page.waitForTimeout(600);
    await expect(applyAllBtn).toBeVisible();
    await expect(applyAllBtn).toHaveClass(/btn-primary/);

    await applyAllBtn.click();
    await page.waitForTimeout(300);

    // Hides immediately after a successful apply — nothing new to apply yet.
    await expect(applyAllBtn).not.toBeVisible();

    await closeAnyModal(page);
    await page.waitForTimeout(300);

    await searchAndOpen(page, 'E2E apply-all child');
    await expect(page.locator('.detail-recurrence-toggle-active, .detail-recurrence-toggle')).toContainText(/every/i);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Reopening the parent starts a fresh session.
    await searchAndOpen(page, title);
    await expect(page.getByRole('button', { name: /apply to all sub-tasks/i })).not.toBeVisible();

    // Editing another appliable field brings the button back.
    await chooseSelectMenuOption(page, 'Priority', 'Medium');
    await page.waitForTimeout(600);
    await expect(page.getByRole('button', { name: /apply to all sub-tasks/i })).toBeVisible();

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('smart-parses a due date and priority typed into the "Add sub-task" field', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Subtask Smart-Parse Parent ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    const childTitle = `E2E smart child ${RUN_ID}`;
    await page.keyboard.type(`${childTitle} tomorrow p1`);
    await page.waitForTimeout(400);

    const chipsText = await page.locator('.smart-chip-row').innerText();
    expect(chipsText).toMatch(/Due/);
    expect(chipsText).toMatch(/Urgent priority/);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(page.getByText('Sub-tasks (0/1)')).toBeVisible();

    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Reopen the sub-task itself and confirm the smart-parsed fields landed —
    // and that the matched phrase was stripped back out of the saved title.
    await searchAndOpen(page, 'E2E smart child');
    const titleField = page.locator('.detail-title-wrap textarea').first();
    await expect(titleField).toHaveValue(childTitle);
    await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('Urgent');
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await expect(dueDateInput).not.toHaveValue('');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('removing a task from its parent while a sidebar edit is still debouncing leaves it top-level', async ({ page }) => {
    // Regression test for a stale-closure bug in TaskDetailModal's sidebar
    // auto-save: editing a sidebar field (e.g. Priority) arms a 500ms
    // debounced commitChanges() call whose closure captures parentId at
    // schedule time. If "Remove from parent task" ran WHILE that timer was
    // still pending, the timer fired afterward and reasserted the stale
    // parent, silently re-nesting the task moments after the user un-nested
    // it — see TaskDetailModal.jsx's parentId local-state tracking and
    // commitChanges' doc comment for the fix.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const parentTitle = `E2E Reparent Race Parent ${RUN_ID}`;
    const childTitle = `E2E reparent race child ${RUN_ID}`;
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(parentTitle);
    await submitAddTask(page);

    await searchAndOpen(page, parentTitle);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await page.keyboard.type(childTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    await searchAndOpen(page, childTitle);
    // Confirm it actually opened nested under the parent before racing anything.
    await expect(page.locator('.detail-hierarchy-link', { hasText: parentTitle })).toBeVisible();

    // Edit a sidebar field to arm the 500ms auto-save debounce, then
    // IMMEDIATELY (well within that window) fire the direct reparent action
    // — this is the race: the debounce timer is still pending when
    // "Remove from parent task" calls updateTask directly.
    await chooseSelectMenuOption(page, 'Priority', 'High');

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /remove from parent task/i }).click();

    // The hierarchy breadcrumb should disappear immediately (direct action).
    await expect(page.locator('.detail-hierarchy-link', { hasText: parentTitle })).toHaveCount(0);

    // Wait well past the 500ms debounce window for the earlier priority
    // edit's timer to fire (if it was going to incorrectly revert the
    // reparent, it would do so in this window).
    await page.waitForTimeout(1000);
    await expect(page.locator('.detail-hierarchy-link', { hasText: parentTitle })).toHaveCount(0);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Reopen from scratch and confirm the reparent truly persisted (not just
    // an in-memory state that a reload/re-fetch would revert) and the
    // priority edit landed too.
    await searchAndOpen(page, childTitle);
    await expect(page.locator('.detail-hierarchy-link', { hasText: parentTitle })).toHaveCount(0);
    await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('High');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('deleting a container\'s last sub-task clears a stale remainingHoursOverride left by a timer', async ({ page }) => {
    // Regression test for SchedulerContext.deleteTask's parentRevertedToLeaf
    // fix. While a task has children, DetailSidebar hides "Time left"
    // entirely and shows a read-only rollup instead (getEffectiveEstimatedHours
    // — see taskHierarchy.js) — but nothing ever stopped a timer (TimerWidget's
    // handleStop) from running against the parent anyway and writing a
    // remainingHoursOverride straight onto it. That override then sits inert
    // until the last child is deleted, at which point the parent reverts to a
    // plain leaf (containment is derived live from getDirectChildren, not a
    // stored flag) and "Time left" would silently read the stale overridden
    // value instead of the full estimate — unless deleteTask clears it.
    //
    // A timer can't actually be started against a container task through the
    // UI: DetailSidebar's "Time left" field (the only place a timer-start
    // control lives, per TaskDetailModal) is conditionally hidden by
    // `!isContainer` (see DetailSidebar.jsx), so there's no reachable path to
    // arm one. The override is therefore seeded directly into localStorage,
    // in the exact shape TimerWidget.handleStop's
    // computeRemainingHoursPatchAfterElapsed would have written for a
    // recurring task (a plain non-recurring task's timer writes straight to
    // `remainingHours` instead, which deleteTask always overwrites via a
    // fresh child-count rollup anyway — recurring is the shape that actually
    // needs deleteTask's explicit clearing fix).
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const parentTitle = `E2E Stale Override Parent ${RUN_ID}`;
    const childTitle = `E2E stale override child ${RUN_ID}`;
    const today = todayIsoLocal();

    await page.evaluate(
      ({ parentTitle, childTitle, today }) => {
        const key = 'taskflow:v1:tasks';
        const existing = JSON.parse(localStorage.getItem(key) || '[]');
        const base = {
          isCompleted: false, isLocked: false, priority: 'medium', dependsOn: [],
          minChunkHours: 0.5, maxChunkHours: 4, source: 'manual', projectId: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        const parent = {
          ...base,
          id: 'e2e_stale_override_parent',
          title: parentTitle,
          // While it's a container, "Estimated time" is a rollup of children
          // (getEffectiveEstimatedHours), not this own value — the child's
          // estimatedHours below (2h) is what actually needs to show through
          // both before and after the delete, so the parent's own value here
          // is otherwise inert until the child is gone.
          estimatedHours: 2,
          dueDate: today,
          isRecurring: true,
          recurrence: { frequency: 'weekly', interval: 1 },
          // The stale write a timer stopped against the container would have
          // left behind — keyed by the occurrence's own due date, same as
          // computeRemainingHoursPatchAfterElapsed. 0.25h (15m) stands in for
          // "an hour and 45 minutes already logged", well below the 2h estimate.
          remainingHoursOverride: { [today]: 0.25 },
        };
        const child = {
          ...base,
          id: 'e2e_stale_override_child',
          title: childTitle,
          parentId: parent.id,
          estimatedHours: 2,
          remainingHours: 2,
        };
        localStorage.setItem(key, JSON.stringify([...existing, parent, child]));
      },
      { parentTitle, childTitle, today }
    );
    await page.reload();
    await page.waitForTimeout(700);

    // Confirm the container state first: "Time left" is hidden, and the
    // rollup shown for "Estimated time" is the full 2h (not affected by the
    // override, which only ever pertains to remainingHours).
    await searchAndOpen(page, parentTitle);
    await expect(page.locator('.detail-field', { hasText: 'Time left' })).toHaveCount(0);
    await expect(page.locator('.detail-field', { hasText: 'Estimated time' })).toContainText('2h');
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Delete the only sub-task — the parent's last child — reverting it to a
    // plain leaf task.
    await searchAndOpen(page, childTitle);
    await page.getByRole('button', { name: /more actions/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page.waitForTimeout(300);

    // The child's own modal closes itself on delete; reopen the parent fresh.
    await searchAndOpen(page, parentTitle);
    await expect(page.locator('.detail-hierarchy-link')).toHaveCount(0); // sanity: still top-level itself
    const timeLeftField = page.locator('.detail-field', { hasText: 'Time left' });
    await expect(timeLeftField).toBeVisible(); // no longer a container — the field is back
    // Fixed behavior: reads the full 2h estimate, not the stale 15m override.
    await expect(timeLeftField.locator('.smart-duration-input')).toHaveValue('2 hours');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Reopening a completed task', () => {
  test('editing the due date of a completed task reopens it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const title = `E2E Reopen On Reschedule ${RUN_ID}`;
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    // Complete it from the list.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) }).click();
    await page.waitForTimeout(300);
    // Dropped out of the default (non-completed) search results.
    await expect(page.locator('main').getByText(title, { exact: false })).toHaveCount(0);

    // Completed tasks are hidden from search by default — reveal them via
    // the "Show completed tasks" dropdown option, then open it.
    const searchInput = page.getByPlaceholder(/search tasks/i);
    await searchInput.fill(title);
    await page.waitForTimeout(300);
    // The search dropdown is a combobox listbox, so its rows are role="option"
    // (not "button") — see SearchBar's aria wiring.
    await page.getByRole('option', { name: 'Show completed tasks' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('option', { name: title, exact: false }).first().click();
    await page.waitForTimeout(300);

    // Reschedule its due date to today — this should reopen the task, not
    // leave it completed with a new deadline.
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    const today = new Date().toISOString().slice(0, 10);
    await dueDateInput.fill(today);
    await dueDateInput.blur();
    await page.waitForTimeout(700);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // The task should be visible again in the default (non-completed) search
    // results, with its "Mark complete" button restored (i.e. no longer
    // isCompleted) — it shouldn't need "Show completed tasks" anymore.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) })).toBeVisible();

    expectNoErrors(errors);
  });
});

test.describe('Dependencies', () => {
  test('a task with an unmet dependency cannot be completed until its blocker is done', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const titleA = `E2E Dep Blocker ${RUN_ID}`;
    const titleB = `E2E Dep Waiter ${RUN_ID}`;

    // Task A (the blocker).
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(titleA);
    await submitAddTask(page);

    // Task B, depends on A via the More options DependencyPicker.
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(titleB);
    const pills = page.locator('.addtask-pill');
    await pills.nth(3).click();
    const depField = page.locator('.detail-field', { hasText: 'Depends on' });
    await expect(depField).toBeVisible();
    const depInput = depField.locator('input[type="text"]');
    await depInput.fill('E2E Dep Blocker');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: titleA }).click();
    await submitAddTask(page);

    // Detail view should show the "Waiting on" warning.
    await searchAndOpen(page, titleB);
    await expect(page.getByText(/Waiting on:.*E2E Dep Blocker/)).toBeVisible();
    await closeAnyModal(page);
    await page.waitForTimeout(200);

    // The list row should show the blocked-by-dependency icon (see
    // TaskListPanel's task-row-status-rail) and clicking complete should
    // refuse (toast) rather than completing it.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(titleB);
    await page.waitForTimeout(300);
    await expect(page.getByTitle('Blocked by dependency')).toBeVisible();

    const completeBBtn = page.getByRole('button', { name: new RegExp(`Mark ${titleB} complete`) });
    await completeBBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('.toast')).toContainText(/Can't complete/i);
    await expect(completeBBtn).toBeVisible(); // still incomplete, row didn't disappear

    // Complete A, then B should be completable.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(titleA);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: new RegExp(`Mark ${titleA} complete`) }).click();
    await page.waitForTimeout(300);

    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(titleB);
    await page.waitForTimeout(300);
    await expect(page.getByTitle('Blocked by dependency')).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(`Mark ${titleB} complete`) }).click();
    await page.waitForTimeout(300);
    // Completed tasks drop out of the default (non-Completed) search results.
    await expect(page.getByText(titleB, { exact: false })).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('cannot pick a dependency that would create a cycle', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    const titleA = `E2E Cycle Blocker ${RUN_ID}`;
    const titleB = `E2E Cycle Waiter ${RUN_ID}`;

    // A (the blocker) — no dependencies of its own.
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(titleA);
    await submitAddTask(page);

    // B depends on A.
    await openAddTask(page);
    await page.getByPlaceholder('Task name').fill(titleB);
    const pills = page.locator('.addtask-pill');
    await pills.nth(3).click();
    const depField = page.locator('.detail-field', { hasText: 'Depends on' });
    await expect(depField).toBeVisible();
    await depField.locator('input[type="text"]').fill('E2E Cycle Blocker');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: titleA }).click();
    await submitAddTask(page);

    // Now try to make A depend on B, which would create a cycle (A -> B -> A).
    // getIneligibleDependencyIds (dependencyUtils.js) walks B's dependents
    // back to A and excludes it from A's own DependencyPicker options — so B
    // should never even appear as a pickable option, rather than being
    // selectable and then rejected.
    await searchAndOpen(page, titleA);
    await page.getByRole('button', { name: /more actions/i }).click();
    await page.waitForTimeout(200);
    const depFieldA = page.locator('.detail-field', { hasText: 'Depends on' });
    await expect(depFieldA).toBeVisible();
    await depFieldA.locator('input[type="text"]').fill('E2E Cycle Waiter');
    await page.waitForTimeout(300);
    await expect(page.getByText('No matching tasks.')).toBeVisible();
    await expect(page.getByRole('button', { name: titleB })).toHaveCount(0);

    // Sanity check the field still works for an unrelated, eligible task —
    // proves the empty result above is cycle-prevention, not a broken picker.
    await depFieldA.locator('input[type="text"]').fill('');
    await page.waitForTimeout(200);
    await expect(page.locator('.dependency-picker-option').first()).toBeVisible();

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Labels', () => {
  test('creating and assigning a label shows its chip on the task, and re-typing the same name reuses it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Label Task ${RUN_ID}`;
    const labelName = `e2edup-${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);

    const pills = page.locator('.addtask-pill');
    await pills.nth(2).click();
    const labelInput = page.locator('.addtask-pill-panel input[type="text"]').first();
    await labelInput.fill(labelName);
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: new RegExp(`Create.*${labelName}`) }).click();
    await pills.nth(2).click();
    await submitAddTask(page);

    await searchAndOpen(page, title);
    await expect(page.locator('.chip.chip-label', { hasText: labelName })).toBeVisible();
    await closeAnyModal(page);
    await page.waitForTimeout(200);

    // Second task: typing the same label name should offer the EXISTING
    // label as a selectable option rather than a "Create" duplicate.
    await openAddTask(page);
    const title2 = `E2E Label Task 2 ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title2);
    const pills2 = page.locator('.addtask-pill');
    await pills2.nth(2).click();
    const labelInput2 = page.locator('.addtask-pill-panel input[type="text"]').first();
    await labelInput2.fill(labelName);
    await page.waitForTimeout(200);
    const createDup = page.getByRole('button', { name: new RegExp(`Create.*${labelName}`) });
    await expect(createDup).toHaveCount(0);
    const existingOption = page.locator('.dependency-picker-option', { hasText: labelName });
    await expect(existingOption).toBeVisible();
    await existingOption.click();
    await pills2.nth(2).click();
    await submitAddTask(page);

    await searchAndOpen(page, title2);
    await expect(page.locator('.chip.chip-label', { hasText: labelName })).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
  });
});

test.describe('Comments', () => {
  test('posting a comment shows it in the thread with a count, and deleting it removes it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);
    const title = `E2E Comment Task ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const commentText = `E2E comment ${RUN_ID}`;
    await page.locator('.comment-input-bar input[type="text"]').fill(commentText);
    await page.locator('.comment-send-btn').click();
    await page.waitForTimeout(400);
    await expect(page.locator('.comment-text', { hasText: commentText })).toBeVisible();
    await expect(page.locator('.comments-section label')).toHaveText('Comments (1/200)');

    // Persists across a reopen (not just optimistic local state).
    await closeAnyModal(page);
    await page.waitForTimeout(200);
    await searchAndOpen(page, title);
    await expect(page.locator('.comment-text', { hasText: commentText })).toBeVisible();

    await page.locator('.comment-row', { hasText: commentText }).locator('.comment-remove').click();
    await page.waitForTimeout(400);
    await expect(page.locator('.comment-text', { hasText: commentText })).toHaveCount(0);
    await expect(page.locator('.comments-section label')).toHaveText('Comments');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Recurring tasks', () => {
  test('completing a recurring task advances its due date instead of marking it complete', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Recurring Task ${RUN_ID}`;
    const titleInput = page.getByPlaceholder('Task name');
    await titleInput.fill(`${title} every monday`);
    await page.waitForTimeout(400);

    // Smart parse should have detected the recurrence and defaulted a due
    // date (needed for a recurring task to be saveable at all).
    await expect(page.locator('.smart-chip-row')).toContainText(/repeats/i);

    await submitAddTask(page);

    await searchAndOpen(page, title);
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    const dueDateBefore = await dueDateInput.inputValue();
    expect(dueDateBefore).toBeTruthy();
    await expect(page.getByText(/Every week on Mon/i)).toBeVisible();
    await closeAnyModal(page);
    await page.waitForTimeout(200);

    // Complete it from the list — should advance the due date, not set
    // isCompleted (see CLAUDE.md: recurring tasks are never marked
    // isCompleted on finishing an occurrence).
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    // Close SearchBar's own live-suggestion dropdown first — left open, it
    // sits on top of the filtered list below and silently swallows the
    // click intended for the "Mark complete" button underneath it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const completeBtn = page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) });
    await completeBtn.click();
    await page.waitForTimeout(400);

    // Still visible in the default (non-completed) search results — a
    // recurring task never moves to the Completed filter. Completing a
    // weekly task immediately rolls its dueDate forward to next Monday
    // (i.e. past today), so per isCheckedForListDisplay's deliberate design
    // (see its doc comment and the matching unit test in
    // taskHierarchy.test.js) it does NOT show checked/struck-through here —
    // that display is reserved for a task still sitting on an occurrence
    // due today or earlier. An active "Mark complete" button reappearing is
    // therefore the correct outcome, now representing the NEXT occurrence,
    // not a sign the original click did nothing (confirmed below: the due
    // date has in fact advanced, and isCompleted itself was never set true).
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) })).toBeVisible();

    // Due date should have advanced, and the detail modal's own recurrence
    // controls should still treat the task as an ongoing recurring task
    // (not a one-off marked permanently done) — confirming isCompleted
    // itself was never set true.
    await searchAndOpen(page, title);
    const dueDateAfterInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    const dueDateAfter = await dueDateAfterInput.inputValue();
    expect(dueDateAfter).not.toEqual(dueDateBefore);
    await expect(page.getByText(/Every week on Mon/i)).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('a recurring sub-task shows checked in the Tasks list once completed for today, without checking its parent', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Recurring Subtask Parent ${RUN_ID}`;
    const childTitle = `E2E recurring child ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    // A second, never-completed sibling so the parent can't auto-complete
    // in this test — isolates "does the completed child show checked" from
    // "does completing every child auto-complete the parent" (covered below).
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await page.keyboard.type(childTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // The "Add a sub-task…" row stays open after adding one (see
    // TaskDetailModal.handleAddSubtask), so the second sibling is typed
    // straight into it rather than re-clicking the (now gone) trigger button.
    await page.keyboard.type(`E2E recurring sibling ${RUN_ID}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Give the child a due date of today, then make it recurring — a
    // recurring task needs a due date to be saveable, and it needs to be
    // TODAY for completing it to record today's date into completedDates.
    await searchAndOpen(page, childTitle);
    const today = todayIsoLocal();
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await dueDateInput.fill(today);
    await page.getByRole('button', { name: /does not repeat/i }).click();
    await page.waitForTimeout(600); // let the sidebar's debounced auto-save land
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Sub-tasks never appear in the list's top-level search results on their
    // own (TaskListPanel.visibleTasks filters out anything with a parentId
    // before matching the query) — they only ever render nested under their
    // parent row. So search for the PARENT to bring both it and its children
    // into view, then act on the child's own row underneath it.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    // Close SearchBar's own live-suggestion dropdown first — left open, it
    // sits on top of the filtered list below and silently swallows the
    // click intended for the "Mark complete" button underneath it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const childCompleteBtn = page.getByRole('button', { name: new RegExp(`Mark ${childTitle} complete`) });
    await childCompleteBtn.click();
    await page.waitForTimeout(400);

    // A recurring SUB-TASK does NOT roll its own dueDate forward on
    // individual completion (unlike a top-level recurring task) — it stays
    // pinned to today's occurrence and shows checked/struck-through until
    // the whole group (every sibling, or the parent directly) closes out.
    // See SchedulerContext.completeTask's `existing.parentId` branch and
    // utils/recurrenceState.js's planSubtaskOccurrenceCompletion.
    await expect(page.getByRole('button', { name: `${childTitle} completed` })).toBeVisible();

    // The parent (with an incomplete sibling) must NOT show checked either.
    await expect(page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) })).toBeVisible();

    expectNoErrors(errors);
  });

  test('completing the last remaining recurring sub-task auto-completes its parent', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Auto-Complete Parent ${RUN_ID}`;
    const child1 = `E2E auto-complete child1 ${RUN_ID}`;
    const child2 = `E2E auto-complete child2 ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await page.keyboard.type(child1);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // The "Add a sub-task…" row stays open after adding one (see
    // TaskDetailModal.handleAddSubtask), so the second child is typed
    // straight into it rather than re-clicking the (now gone) trigger button.
    await page.keyboard.type(child2);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Complete both children (plain, non-recurring — simplest way to check
    // the upward cascade without needing today-dated recurrence on both).
    // Sub-tasks never appear in the list's top-level search results on their
    // own (TaskListPanel.visibleTasks filters out anything with a parentId
    // before matching the query) — search for the PARENT so both it and its
    // children render, then act on each child's own row underneath it.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: new RegExp(`Mark ${child1} complete`) }).click();
    await page.waitForTimeout(400);

    // Parent still incomplete — one sibling remains.
    await expect(page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) })).toBeVisible();

    // Complete the last remaining sub-task — the parent should auto-complete
    // (a *plain* completion, isCompleted: true, since the parent itself
    // isn't recurring — see SchedulerContext.applyUpwardCompletionCascade).
    await page.getByRole('button', { name: new RegExp(`Mark ${child2} complete`) }).click();
    await page.waitForTimeout(400);

    // A completed non-recurring task drops out of the default ("Scheduled")
    // filter's search results entirely (see TaskListPanel.visibleTasks) —
    // switch to the "Completed" filter chip to confirm the parent really did
    // auto-complete.
    await expect(page.getByText(title, { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.getByRole('menuitemradio', { name: 'Completed' }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: `${title} completed` })).toBeVisible();

    expectNoErrors(errors);
  });

  test('editing a recurring parent\'s due date also shifts a recurring sub-task\'s displayed due date', async ({ page }) => {
    // See utils/recurrenceState.js's computeRecurringDescendantDueDateOverrides:
    // a manual due-date edit on a recurring parent temporarily overrides the
    // sub-task's DISPLAYED due date to match, without touching the sub-task's
    // own recurrence pattern/anchor underneath.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Recurring Cascade Parent ${RUN_ID}`;
    const childTitle = `E2E recurring cascade child ${RUN_ID}`;
    const today = todayIsoLocal();
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    // Give the parent a due date and make it recurring.
    await searchAndOpen(page, title);
    const parentDueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await parentDueDateInput.fill(today);
    await page.getByRole('button', { name: /does not repeat/i }).click();
    await page.waitForTimeout(600);

    // Add a recurring sub-task with its own (different) due date/pattern.
    const addSubtaskBtn = page.getByRole('button', { name: /add sub-task/i });
    await addSubtaskBtn.click();
    await page.keyboard.type(childTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // A new sub-task under a recurring parent automatically becomes recurring
    // too (see computeRecurrenceSyncUpdates), so there's no "does not repeat"
    // toggle to click here — just give it its own due date of today.
    await searchAndOpen(page, childTitle);
    const childDueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await childDueDateInput.fill(today);
    await childDueDateInput.blur();
    await page.waitForTimeout(600);
    await expect(page.locator('.detail-recurrence-toggle-active, .detail-recurrence-toggle').first()).toContainText(/every/i);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Now edit the PARENT's due date to a week from today — the sub-task's
    // own recurring pattern is untouched, but its displayed due date should
    // shift to match for this cycle.
    const newDate = new Date();
    newDate.setDate(newDate.getDate() + 7);
    const newDateIso = `${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, '0')}-${String(newDate.getDate()).padStart(2, '0')}`;

    await searchAndOpen(page, title);
    const parentDueDateInput2 = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await parentDueDateInput2.fill(newDateIso);
    await parentDueDateInput2.blur();
    await page.waitForTimeout(600);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Search for the parent so the child renders nested underneath it, then
    // confirm the child's list row now shows the new (parent's) due date.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    const childRow = page.locator('.task-row', { hasText: childTitle });
    await expect(childRow).toBeVisible();
    // Matches formatDisplayDate's own toLocaleDateString call exactly (see
    // utils/dateUtils.js) — computed IN the browser page (not Node), whose
    // default locale can differ from the test runner's, and parsed as a
    // local date (not UTC) the same way fromISODate does, so this can't
    // drift a day near a UTC boundary either.
    const expectedLabel = await page.evaluate((iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    }, newDateIso);
    await expect(childRow).toContainText(`due ${expectedLabel}`);

    expectNoErrors(errors);
  });

  test('moving a weekday-pinned recurring task off-pattern settles without looping or reverting', async ({ page }) => {
    // Regression coverage for TaskDetailModal's sidebar auto-save
    // self-re-arming loop bug. A weekly rule pinned to specific weekdays
    // (e.g. "every monday") records an off-pattern manual move (e.g. onto a
    // Wednesday) as a one-occurrence override rather than re-anchoring the
    // series (see utils/recurrence.js's computeRecurringRescheduleUpdate) —
    // one of several updateTask cascade paths (see also
    // computeEnforceDueDateSyncUpdates) that can settle a field onto a
    // different value than what commitChanges() requested, which is what the
    // fix's isReconcilingOwnCommitRef/suppressNextAutoSaveRef mechanism in
    // TaskDetailModal.jsx guards against. This specific scenario turns out
    // not to reach that guard in practice — resolveCurrentOccurrenceDueDate
    // already resolves the override transparently, so the modal's own
    // snapshot and the cascade's result agree without any correction being
    // needed — but it's kept as a direct regression test for this cascade
    // path's *outcome* (no flicker/revert across the debounce window) since
    // it's cheap, realistic, and would catch a regression in either the
    // cascade or the modal's handling of it.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Off-Pattern Recurring ${RUN_ID}`;
    const titleInput = page.getByPlaceholder('Task name');
    await titleInput.fill(`${title} every monday`);
    await page.waitForTimeout(400);
    await expect(page.locator('.smart-chip-row')).toContainText(/repeats/i);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    await expect(page.getByText(/Every week on Mon/i)).toBeVisible();

    // Move the due date onto a Wednesday two weeks out — off the Monday
    // pattern, so this lands on computeRecurringRescheduleUpdate's override
    // branch instead of a plain re-anchor.
    const nextWednesday = new Date();
    nextWednesday.setDate(nextWednesday.getDate() + ((3 - nextWednesday.getDay() + 7) % 7 || 7) + 7);
    const wedIso = `${nextWednesday.getFullYear()}-${String(nextWednesday.getMonth() + 1).padStart(2, '0')}-${String(nextWednesday.getDate()).padStart(2, '0')}`;

    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await dueDateInput.fill(wedIso);
    await dueDateInput.blur();

    // Sample the field repeatedly across and past the 500ms debounce window
    // — if the bug's loop were still present, the value would be seen
    // reverting/flip-flopping at some point in this window rather than
    // settling once and staying put.
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(300);
      samples.push(await dueDateInput.inputValue());
    }
    expect(samples.every((v) => v === wedIso)).toBe(true);

    // The series' own pattern stays anchored on Monday underneath the
    // override — confirm that didn't get silently re-anchored onto Wednesday.
    await expect(page.getByText(/Every week on Mon/i)).toBeVisible();

    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Reopen from scratch to confirm the moved date actually persisted.
    await searchAndOpen(page, title);
    const dueDateInput2 = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await expect(dueDateInput2).toHaveValue(wedIso);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Smart parse', () => {
  test('detects due date, priority, project, and label chips together from natural-language title', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const titleInput = page.getByPlaceholder('Task name');
    await titleInput.fill(`Call dentist tomorrow p2 #Personal @errand ${RUN_ID}min`);
    await page.waitForTimeout(400);

    const chipsText = await page.locator('.smart-chip-row').innerText();
    expect(chipsText).toMatch(/Due/);
    expect(chipsText).toMatch(/High priority/);
    expect(chipsText).toMatch(/Project: Personal/);
    expect(chipsText).toMatch(/#errand/i);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('detects "!noauto" as an exclude-from-auto-schedule chip, saves it, and the task detail menu can toggle it back off', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E noauto task ${RUN_ID}`;
    const titleInput = page.getByPlaceholder('Task name');
    await titleInput.fill(`${title} !noauto`);
    await page.waitForTimeout(400);

    const chipsText = await page.locator('.smart-chip-row').innerText();
    expect(chipsText).toMatch(/Excluded from auto-schedule/i);

    // "More options" pill should show its "is-set" state once the checkbox
    // is implicitly checked via the smart-parsed chip.
    await submitAddTask(page);

    await searchAndOpen(page, title);
    await expect(page.getByRole('dialog')).toBeVisible();

    // Toggle back off via the "..." menu, mirroring the Lock/Unlock toggle.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.waitForTimeout(200);
    const menuItem = page.getByRole('menuitem', { name: /auto-schedule/i });
    await expect(menuItem).toHaveText(/Include in auto-schedule/i);
    await menuItem.click();
    await page.waitForTimeout(300);

    // Re-open the menu and confirm the label flipped, confirming the toggle persisted.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.waitForTimeout(200);
    await expect(page.getByRole('menuitem', { name: /auto-schedule/i })).toHaveText(/Exclude from auto-schedule/i);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('multi-word "#Project Name" resolves the full project (not just its first word) even when another project shares that first word', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // Two projects sharing a leading word — findProjectPhrase (smartParse.js)
    // must try full project names longest-first so "#Work Trip" resolves to
    // "Work Trip", not the shorter "Work" with "Trip" left dangling in the title.
    const projectA = `Work Trip ${RUN_ID}`;
    const projectB = `Work Notes ${RUN_ID}`;
    await gotoTab(page, 'Projects');
    await page.getByRole('button', { name: 'Manage projects' }).click();
    const projectsDialog = page.getByRole('dialog', { name: 'Manage projects' });
    await expect(projectsDialog).toBeVisible();
    for (const name of [projectA, projectB]) {
      await projectsDialog.getByRole('button', { name: /^add project$/i }).click();
      const addProjectDialog = page.getByRole('dialog', { name: 'Add project' });
      await addProjectDialog.getByPlaceholder('Project name').fill(name);
      await addProjectDialog.getByRole('button', { name: /^add project$/i }).click();
      await page.waitForTimeout(300);
    }
    await closeAnyModal(page);
    await expect(projectsDialog).toBeHidden();

    await openAddTask(page);
    const title = `Pack bags #${projectA}`;
    await page.getByPlaceholder('Task name').fill(title);
    await page.waitForTimeout(400);

    const chipsText = await page.locator('.smart-chip-row').innerText();
    expect(chipsText).toMatch(new RegExp(`Project: ${projectA}`));

    await submitAddTask(page);

    // Saved title should be clean (the "#Work Trip <id>" mention stripped
    // out entirely) and the task's project should be the longer "Work Trip
    // <id>", not "Work Notes <id>" or plain "Work".
    await searchAndOpen(page, 'Pack bags');
    await expect(page.locator('.detail-title-input, .modal-detail textarea').first()).not.toHaveValue(new RegExp(`#${projectA}`));
    await expect.poll(() => selectMenuLabel(page, 'Project')).toBe(projectA);
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('a bare number is never smart-parsed as a fixed time, with or without "at"', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const titleInput = page.getByPlaceholder('Task name');
    const chipsRow = page.locator('.smart-chip-row');

    // "at 9" — bare hour, no am/pm, no minutes: must not match (previously
    // misread as 24hr "09:00").
    await titleInput.fill('Task at 9');
    await page.waitForTimeout(300);
    await expect(chipsRow.getByText(/^At /)).toHaveCount(0);

    // Bare "17:30" with no "at" and no am/pm must also not match — only the
    // "at"-prefixed form is allowed the bare-24hr reading, and even that
    // requires minutes or am/pm (covered above).
    await titleInput.fill('Task 17:30');
    await page.waitForTimeout(300);
    await expect(chipsRow.getByText(/^At /)).toHaveCount(0);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('a standalone time with am/pm (no "at") is still detected as a fixed time', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const titleInput = page.getByPlaceholder('Task name');
    await titleInput.fill('Call dentist 9:10pm');
    await page.waitForTimeout(300);

    await expect(page.locator('.smart-chip-row')).toContainText('At 9:10 PM');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('re-arms after dismissing a fixed-time chip, editing to a different valid time, then coming back to the original phrase', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const titleInput = page.getByPlaceholder('Task name');
    const chipsRow = page.locator('.smart-chip-row');

    await titleInput.fill('Task at 9pm');
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('At 9:00 PM');

    // Dismiss the chip.
    await page.getByRole('button', { name: /dismiss.*9:00 pm/i }).click();
    await page.waitForTimeout(300);
    await expect(chipsRow.getByText(/^At /)).toHaveCount(0);

    // Edit straight to a DIFFERENT valid time phrase — this transition never
    // passes through a "no match" state, which is what used to leave the
    // original dismissal stuck forever (see useSmartTaskTitle.js).
    await titleInput.fill('Task at 10pm');
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('At 10:00 PM');

    // Coming back to the originally-dismissed phrase should re-arm and show
    // the chip again, not stay silently suppressed.
    await titleInput.fill('Task at 9pm');
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('At 9:00 PM');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('editing a task title keeps smart parse retriggerable after continuing to type (TaskDetailModal)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `Edit smart parse retrigger ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await searchAndOpen(page, title);
    const dialog = page.getByRole('dialog');
    const titleInput = dialog.locator('.smart-title-input');
    const chipsRow = dialog.locator('.smart-chip-row');
    const dueDateInput = dialog.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');

    // Type a due-date phrase — chip should appear and the field should apply.
    await titleInput.fill(`${title} tomorrow`);
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('Due');
    const dueDateAfterFirstParse = await dueDateInput.inputValue();
    expect(dueDateAfterFirstParse).toBeTruthy();

    // Continue typing (e.g. a trailing space) — the chip/apply must survive
    // this, not silently revert-and-lock like the bug this test guards
    // against (see useSmartTaskTitle.js's isUntouched() contract and each
    // TaskDetailModal field's lastSmart*Ref guards).
    await titleInput.fill(`${title} tomorrow `);
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('Due');
    await expect(dueDateInput).toHaveValue(dueDateAfterFirstParse);

    // A different due-date phrase must still be able to re-parse afterward —
    // this is what stayed permanently blocked under the bug.
    await titleInput.fill(`${title} today`);
    await page.waitForTimeout(300);
    await expect(chipsRow).toContainText('Due');
    const dueDateAfterSecondParse = await dueDateInput.inputValue();
    expect(dueDateAfterSecondParse).toBeTruthy();
    expect(dueDateAfterSecondParse).not.toEqual(dueDateAfterFirstParse);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Validation edge cases', () => {
  test('blank/whitespace title blocks submission', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill('   ');
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(300);

    await expect(page.getByText(/give the task a title/i)).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible(); // modal stayed open

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('missing-info hint no longer claims "a duration" once smart-parse detects one from the title', async ({ page }) => {
    // Regression test: the hint used to check `hasEditedHours` (whether the
    // user MANUALLY touched the duration field) for whether a duration was
    // "specified" at all — but smart-parse setting a duration via a detected
    // chip never sets that flag (by design, so a later manual edit can still
    // override it), so the hint kept claiming "you haven't specified a
    // duration" even with an "Est. Nh" chip visibly applied underneath.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const hint = page.getByText(/you haven't specified/i);
    await page.getByPlaceholder('Task name').fill(`E2E Duration Chip ${RUN_ID} next wed 8 hours`);
    await expect(hint).toBeVisible();

    // The smart-parse chip should appear...
    await expect(page.getByText(/Est\. 8h/)).toBeVisible();
    // ...and the hint should not claim a duration is missing, even though
    // the user never manually edited the duration field — only "a project"
    // remains unspecified (title's smart-parse also set the due date).
    await expect(hint).not.toContainText('a duration');
    await expect(hint).toContainText('a project');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('missing-info hint appears only after typing a title, and clears as fields are filled in', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const hint = page.getByText(/you haven't specified/i);
    await expect(hint).not.toBeVisible();

    await page.getByPlaceholder('Task name').fill(`E2E Missing Info ${RUN_ID}`);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('a project');
    await expect(hint).toContainText('a due date');
    await expect(hint).toContainText('a duration');

    // Clearing the title back to empty must not hide the hint again.
    await page.getByPlaceholder('Task name').fill('');
    await expect(hint).toBeVisible();
    await page.getByPlaceholder('Task name').fill(`E2E Missing Info ${RUN_ID}`);

    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click(); // Date pill
    await page.locator('.addtask-pill-panel input[type="date"]').fill('2026-09-01');
    await expect(hint).not.toContainText('a due date');
    await expect(hint).toContainText('a project');
    await expect(hint).toContainText('a duration');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('checking "Fixed time" without picking a time blocks submission', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill(`E2E Fixed Time Edge ${RUN_ID}`);
    const pills = page.locator('.addtask-pill');
    await pills.nth(3).click(); // More options
    await page.getByRole('checkbox', { name: 'Not fixed' }).check();
    // No time picked yet — the time <input type="time"> defaults to blank.
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(300);

    await expect(page.getByText(/pick a time.*fixed time/i)).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible(); // modal stayed open

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('an extremely long title is accepted without crashing', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const longTitle = `E2E Long ${RUN_ID} ` + 'x'.repeat(500);
    await page.getByPlaceholder('Task name').fill(longTitle);
    await submitAddTask(page);

    await gotoTab(page, 'Tasks');
    await page.getByPlaceholder(/search tasks/i).fill(`E2E Long ${RUN_ID}`);
    await page.waitForTimeout(300);
    await expect(page.getByText(`E2E Long ${RUN_ID}`, { exact: false }).first()).toBeVisible();

    expectNoErrors(errors);
  });

  test('a negative/zero duration typed into the estimated-time field is ignored rather than accepted as-is', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill(`E2E Duration Edge ${RUN_ID}`);
    const pills = page.locator('.addtask-pill');
    await pills.nth(3).click();
    const durationInput = page.locator('.smart-duration-input');
    await durationInput.click();
    const beforeValue = await durationInput.inputValue();
    await durationInput.fill('-5min');
    await page.waitForTimeout(150);
    // No valid duration phrase was recognized (findDurationPhrase requires a
    // positive number) so the field's underlying value should be unchanged
    // from what it was before this keystroke — no crash, no negative commit.
    const afterInvalidValue = await durationInput.inputValue();
    expect(afterInvalidValue).toBe('-5min'); // raw text while focused, un-parsed
    await durationInput.blur();
    await page.waitForTimeout(150);
    // On blur, since nothing parsed, the previously-committed (default)
    // value is restored rather than persisting the unparsed negative text.
    await expect(durationInput).not.toHaveValue('-5min');

    expectNoErrors(errors);
    await closeAnyModal(page);
  });

  test('invalid/unparseable due-date text in the title is ignored gracefully (no crash, no due-date chip)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill(`E2E Bad Date ${RUN_ID} due Blorptember 45th`);
    await page.waitForTimeout(300);

    const chipsRow = page.locator('.smart-chip-row');
    const hasDueChip = await chipsRow.getByText(/^Due /).isVisible({ timeout: 500 }).catch(() => false);
    expect(hasDueChip).toBe(false);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

  test('an out-of-range recurrence count is rejected with a hint instead of being silently rewritten', async ({ page }) => {
    // Regression guard: this field used to clamp inside onChange
    // (Math.min(999, Math.max(1, Number(...) || 1))), so typing past the max
    // rewrote the keystroke as you typed and clearing the box snapped it to 1
    // — both with no explanation. It now goes through NumberField like the
    // Settings number fields do.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill(`E2E recurrence range ${RUN_ID}`);

    // Recurrence needs a due date before its checkbox is enabled, and lives
    // behind the "More options" pill.
    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill('2027-01-15');
    await pills.nth(0).click();
    await page.getByRole('button', { name: 'More options' }).click();
    await page.locator('.form-checkbox-row input[type=checkbox]').first().check();

    const count = page.locator('.detail-field-inline input[type=number]').first();
    await expect(count).toHaveValue('1');

    await count.fill('5000');
    await count.blur();
    await expect(page.locator('.field-rejection-hint')).toContainText('between 1 and 999');
    await expect(count).toHaveValue('1');

    await count.fill('');
    await count.blur();
    await expect(page.locator('.field-rejection-hint')).toBeVisible();
    await expect(count).toHaveValue('1');

    await count.fill('3');
    await count.blur();
    await expect(page.locator('.field-rejection-hint')).toHaveCount(0);
    await expect(count).toHaveValue('3');

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

test.describe('Preferred time of day', () => {
  test('smart-parses "in the morning", fills the picker, and saves it on the task', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E morning task ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(`${title} in the morning`);
    await page.waitForTimeout(500);

    // Surfaced as a dismissible chip like every other detected field, rather
    // than applied silently.
    await expect(page.locator('.smart-chip-row')).toContainText(/prefers morning/i);

    await page.getByRole('button', { name: 'More options' }).click();
    // A SelectMenu, not a native <select> — read the displayed label.
    expect(await selectMenuLabel(page, 'Preferred time of day')).toBe('Morning');

    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill('2027-02-01');
    await pills.nth(0).click();
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(600);

    const saved = await page.evaluate(
      (t) => JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').find((x) => x.title === t),
      title
    );
    // The phrase is consumed into the field, not left in the title.
    expect(saved.preferredTimeOfDay).toBe('morning');

    expectNoErrors(errors);
  });

  test('a bare "Morning" in a title is left alone', async ({ page }) => {
    /* The deliberate restriction: "Morning standup" is a name, not a
       preference. Quietly eating that word and biasing the schedule would be
       worse than missing the hint. */
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    await page.getByPlaceholder('Task name').fill(`Morning standup notes ${RUN_ID}`);
    await page.waitForTimeout(500);
    // Count rather than not.toContainText: with no chips at all the row
    // element doesn't exist, and a negated text assertion needs one to inspect.
    await expect(page.getByRole('dialog').getByText(/prefers (morning|afternoon|evening)/i)).toHaveCount(0);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });
});

  test('changing the preferred time on an existing task saves once, without a write loop', async ({ page }) => {
    /* This is the regression guard for the bug that got a first attempt at this
       reverted. The field has to appear in SEVEN places in TaskDetailModal — the
       two snapshot builds, the reconcile effect's taskValues/setters/localValues,
       sidebarDirty, the commitChanges payload, AND the post-save snapshot
       rebuild. Miss the last one and the field stays dirty after its own save,
       so the debounce re-arms and writes forever: it pegged the CPU and killed
       the browser mid-suite, surfacing as unrelated tests timing out.

       Counting persistence writes is what makes that visible. A functional
       assertion alone passes happily while the loop runs in the background. */
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    await page.locator('.task-row').first().click();
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      window.__taskWrites = 0;
      const orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = (k, v) => {
        if (k.endsWith(':tasks')) window.__taskWrites += 1;
        return orig(k, v);
      };
    });

    // Baseline: an open modal with nothing touched must not write at all.
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__taskWrites)).toBe(0);

    // The picker lives in the task's "⋯" menu, not the always-visible sidebar.
    await page.getByRole('button', { name: /more/i }).first().click();
    await page.waitForTimeout(300);
    const select = page.getByLabel('Preferred time of day');
    await expect(select).toBeVisible();
    await select.selectOption('afternoon');
    await page.waitForTimeout(1200);

    const afterEdit = await page.evaluate(() => window.__taskWrites);
    expect(afterEdit).toBeGreaterThan(0);

    // The load-bearing assertion: idling after the save must add nothing.
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => window.__taskWrites)).toBe(afterEdit);

    // And it actually persisted.
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').filter((t) => t.preferredTimeOfDay === 'afternoon')
    );
    expect(stored.length).toBe(1);

    // Clearing it back to no preference works too, and writes null not ''.
    await select.selectOption('');
    await page.waitForTimeout(1200);
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').filter((t) => t.preferredTimeOfDay).length
      )
    ).toBe(0);

    await closeAnyModal(page);
    expectNoErrors(errors);
  });

test.describe('Postponement counter', () => {
  /**
   * The exclusions are what this guards, not the happy path. The counter is
   * only trustworthy if an ordinary edit doesn't inflate it — and
   * TaskDetailModal's commitChanges resubmits `dueDate` on EVERY autosave
   * whether or not the user touched that field, so "a due date arrived in the
   * update" is not evidence of a postponement. A unit test can't reach that:
   * it's a property of the real autosave path.
   */
  test('counts only a due date the user pushed later, and badges it past the threshold', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Postpone ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill('2027-03-01');
    await pills.nth(0).click();
    await submitAddTask(page);

    const readCount = () =>
      page.evaluate(
        (t) => JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').find((x) => x.title === t)?.postponeCount ?? null,
        title
      );

    // A brand-new task has no history at all — not a stored zero.
    expect(await readCount()).toBeNull();

    async function editAndClose(action) {
      await searchAndOpen(page, title);
      await action();
      await page.waitForTimeout(1500); // clear the autosave debounce
      await closeAnyModal(page);
      await page.getByPlaceholder(/search tasks/i).fill('');
      await page.waitForTimeout(200);
    }
    const setDueDate = (value) => () => page.locator('.detail-sidebar input[type="date"]').first().fill(value);

    // An unrelated edit resubmits the same due date. Must not count.
    await editAndClose(() => page.locator('.detail-notes-textarea').first().fill('unrelated edit'));
    expect(await readCount()).toBeNull();

    // Pushed later — counts.
    await editAndClose(setDueDate('2027-04-01'));
    expect(await readCount()).toBe(1);

    // Pulled earlier — pulling work forward is not a slip.
    await editAndClose(setDueDate('2027-03-15'));
    expect(await readCount()).toBe(1);

    // Below the threshold nothing renders — the absence of a badge is the
    // signal that nothing is stuck.
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(400);
    await expect(page.locator('.badge.postponed')).toHaveCount(0);
    await page.getByPlaceholder(/search tasks/i).fill('');

    await editAndClose(setDueDate('2027-05-01'));
    await editAndClose(setDueDate('2027-06-01'));
    expect(await readCount()).toBe(3);

    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(400);
    await expect(page.locator('.badge.postponed').first()).toHaveText(/pushed 3/);

    expectNoErrors(errors);
  });

  test('a recurring task advancing on completion never counts as a slip', async ({ page }) => {
    /* A recurring task's due date is designed to move, so counting it would
       make every long-lived routine look chronically postponed. */
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const title = `E2E Recurring Postpone ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(`${title} every day`);
    const pills = page.locator('.addtask-pill');
    await pills.nth(0).click();
    await page.locator('.addtask-pill-panel input[type="date"]').fill('2027-03-01');
    await pills.nth(0).click();
    await submitAddTask(page);

    const read = () =>
      page.evaluate((t) => {
        const x = JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').find((y) => y.title === t);
        return x ? { isRecurring: !!x.isRecurring, postponeCount: x.postponeCount ?? null } : null;
      }, title);

    expect((await read()).isRecurring).toBe(true);

    // Even a manual push on a recurring task stays uncounted.
    await searchAndOpen(page, title);
    await page.locator('.detail-sidebar input[type="date"]').first().fill('2027-04-01');
    await page.waitForTimeout(1500);
    await closeAnyModal(page);
    expect((await read()).postponeCount).toBeNull();

    expectNoErrors(errors);
  });
});

test.describe('Quick reschedule', () => {
  /**
   * Desktop: a hover-revealed button on each task row opens a small menu of
   * due-date shortcuts (Tomorrow / In 3 days / Next week / Pick a date...).
   * It must stay hidden until hovered, and must sit to the left of the
   * existing sub-task collapse/expand chevron rather than overlapping it
   * when a row has both.
   */
  test('desktop: hover reveals the reschedule button, and it sits left of the collapse chevron', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await openAddTask(page);

    const parentTitle = `E2E Reschedule Parent ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(parentTitle);
    await submitAddTask(page);

    // Give it a sub-task so both the reschedule button and the collapse
    // chevron are present on the same row at once.
    await searchAndOpen(page, parentTitle);
    await page.getByRole('button', { name: /add sub-?task/i }).click();
    await page.getByPlaceholder(/sub-?task/i).fill('E2E sub-task');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await closeAnyModal(page);
    await clearSearch(page);

    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill(parentTitle);
    await page.waitForTimeout(300);
    const row = page.locator('.task-row', { hasText: parentTitle }).first();

    // Hidden-until-hover here is an opacity fade (matching the row's other
    // hover-reveal controls), not display:none, so Playwright's own
    // visibility check (which only cares about layout/display) sees it as
    // "visible" the whole time — assert on the computed opacity instead.
    const rescheduleBtn = row.locator('.task-row-reschedule');
    await expect.poll(() => rescheduleBtn.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await row.hover();
    await expect.poll(() => rescheduleBtn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    const rescheduleBox = await rescheduleBtn.boundingBox();
    const collapseBox = await row.locator('.task-row-collapse').boundingBox();
    expect(rescheduleBox.x + rescheduleBox.width).toBeLessThanOrEqual(collapseBox.x + 1);

    await rescheduleBtn.click();
    const menu = page.locator('.reschedule-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Tomorrow');
    await expect(menu).toContainText('In 3 days');
    await expect(menu).toContainText('Next week');
    await expect(menu).toContainText('Pick a date');

    const readDueDate = () =>
      page.evaluate(
        (t) => JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').find((x) => x.title === t)?.dueDate ?? null,
        parentTitle
      );
    expect(await readDueDate()).toBeNull();

    await menu.getByText('Tomorrow', { exact: true }).click();
    await page.waitForTimeout(300);
    await expect(menu).toHaveCount(0);
    expect(await readDueDate()).not.toBeNull();

    await clearSearch(page);
    expectNoErrors(errors);
  });

  /**
   * Mobile: there is no tappable reschedule button on a row at all (that's
   * desktop-only) — the swipe gesture itself is the trigger. Swiping a row
   * left past a threshold opens the reschedule menu directly (centered,
   * since there's no button to anchor it to) and the row snaps straight
   * back to resting, never staying visibly swiped open. A short swipe under
   * the threshold does nothing. A real drag needs genuine touch input — a
   * plain viewport resize doesn't make Chromium emit touch/pointer events
   * the way framer-motion's drag gesture recognizer expects, so this uses a
   * real touch-capable context and drives it via CDP's
   * Input.dispatchTouchEvent (mouse-event or synthetic PointerEvent
   * simulation doesn't reliably register as a drag).
   */
  test('mobile: swiping a row left past the threshold opens the reschedule menu directly and the row snaps back', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    // InstallAppBanner (persistent, unlike the transient toasts around it in
    // .floating-notifications) only renders on a mobile viewport, and at
    // this viewport height it overlaps the "Add task" FAB — pre-dismiss it
    // the same way gotoApp already pre-seeds "tutorial seen", since a real
    // first-time mobile user would see the same overlap otherwise handled
    // by their own one-time dismissal of the banner. Set AFTER gotoApp (not
    // via an earlier addInitScript) since gotoApp's own init script wipes
    // every `taskflow:`-prefixed key and would otherwise clear this too —
    // and a plain page.evaluate here only needs a reload to take effect,
    // same as any other persisted setting the app reads once on boot.
    await page.evaluate(() => window.localStorage.setItem('taskflow:v1:addToHomeScreenDismissed', 'true'));
    await page.reload();
    await page.waitForTimeout(500);
    await openAddTask(page);

    const title = `E2E Swipe Reschedule ${RUN_ID}`;
    await page.getByPlaceholder('Task name').fill(title);
    await submitAddTask(page);

    await gotoTab(page, 'Tasks');
    const search = page.getByPlaceholder(/search tasks/i);
    await search.fill(title);
    await page.waitForTimeout(300);
    // The search box's own suggestion listbox stays open (and overlapping
    // the row below it) until something else takes focus — collapse it
    // before touching the row, or a tap meant for the row hits the
    // suggestion overlay instead.
    await search.blur();
    await page.waitForTimeout(200);
    const row = page.locator('.task-row', { hasText: title }).first();
    await expect(row).toBeVisible();

    // Desktop's hover-revealed button is desktop-only — mobile has no
    // tappable reschedule trigger on the row at all.
    await expect(row.locator('.task-row-reschedule')).toHaveCount(0);

    const box = await row.boundingBox();
    const startX = box.x + box.width - 30;
    const startY = box.y + box.height / 2;
    const touchPoints = (x, y) => [{ x, y, id: 1 }];
    const content = row.locator('.task-row-swipe-content');

    async function swipeLeft(distance) {
      // framer-motion's drag gesture only arms for a genuine touch-
      // originated pointer sequence on a touch-capable device (a plain
      // page.mouse drag, tried here first, never triggers it at all under
      // hasTouch context), so the drag itself has to go through CDP's raw
      // touch dispatch.
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(startX, startY) });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: touchPoints(startX - (distance * i) / steps, startY),
        });
        await page.waitForTimeout(20);
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(500);
    }

    // A short swipe under the threshold (SWIPE_OPEN_THRESHOLD_PX = 48) does
    // nothing — no menu, and the row is back at rest, not stuck mid-swipe.
    await swipeLeft(20);
    await expect(page.locator('.reschedule-menu')).toHaveCount(0);
    expect(await content.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

    // A full swipe past the threshold opens the menu directly...
    const readDueDate = () =>
      page.evaluate(
        (t) => JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]').find((x) => x.title === t)?.dueDate ?? null,
        title
      );
    expect(await readDueDate()).toBeNull();

    await swipeLeft(120);
    const menu = page.locator('.reschedule-menu');
    await expect(menu).toBeVisible();
    // No anchor button exists on mobile, so the menu opens centered rather
    // than pinned to a trigger's position.
    await expect(menu).toHaveClass(/menu-popover-centered/);

    // ...and the row is already back at its resting position underneath,
    // not left visibly swiped open behind the menu.
    expect(await content.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

    await menu.getByText('Tomorrow', { exact: true }).click();
    await page.waitForTimeout(300);
    await expect(menu).toHaveCount(0);
    expect(await readDueDate()).not.toBeNull();

    // Tapping a row (no swipe) still opens the task as normal.
    await row.tap();
    await expect(page.getByRole('dialog')).toBeVisible();

    expectNoErrors(errors);
    await context.close();
  });
});

test.describe('Task templates', () => {
  /**
   * The round trip is the assertion. A template stores due dates as day
   * OFFSETS and parent/dependency links as template-local ids, so the thing
   * that can silently break is a reference: a rebuilt task pointing at the
   * ORIGINAL task instead of its new sibling produces a plausible-looking tree
   * that's quietly wrong, with no error anywhere.
   */
  test('saves a subtree as a template, then rebuilds it around a new start date', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // Seeded directly: building the shape through the UI would be a test of
    // sub-task creation and date editing, both covered elsewhere in this file.
    await page.evaluate(() => {
      const key = 'taskflow:v1:tasks';
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const base = {
        isCompleted: false, isLocked: false, estimatedHours: 1, remainingHours: 1, priority: 'medium',
        dependsOn: [], minChunkHours: 0.5, maxChunkHours: 4, source: 'manual', projectId: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      all.push(
        { ...base, id: 'tplsrc_root', title: 'TPLSRC Ship it', dueDate: '2027-03-01' },
        { ...base, id: 'tplsrc_draft', title: 'TPLSRC Draft notes', dueDate: '2027-03-04', parentId: 'tplsrc_root' },
        { ...base, id: 'tplsrc_review', title: 'TPLSRC Review notes', dueDate: '2027-03-11', parentId: 'tplsrc_root', dependsOn: ['tplsrc_draft'] }
      );
      localStorage.setItem(key, JSON.stringify(all));
    });
    await page.reload();
    await gotoTab(page, 'Tasks');
    await page.waitForTimeout(600);

    await searchAndOpen(page, 'TPLSRC Ship it');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitem', { name: /save as template/i }).click();
    // The preview states the span before committing — 1 to 11 March inclusive.
    await expect(page.getByText(/3 tasks over 11 days/)).toBeVisible();
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await page.waitForTimeout(500);
    await closeAnyModal(page);
    await page.getByPlaceholder(/search tasks/i).fill('');

    // Stored as offsets, with no absolute date that would pin it to March.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('taskflow:v1:taskTemplates') || '[]'));
    expect(stored).toHaveLength(1);
    expect(stored[0].tasks.map((t) => t.dueDayOffset).sort((a, b) => a - b)).toEqual([0, 3, 10]);
    expect(JSON.stringify(stored[0])).not.toContain('2027-03');

    // Instantiate from the command palette against a different start date.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.getByLabel('Command palette search').fill('template');
    await page.waitForTimeout(300);
    await palette.getByRole('option', { name: 'New from template' }).click();
    await page.waitForTimeout(400);

    await page.locator('.modal input[type="date"]').first().fill('2027-09-06');
    await page.waitForTimeout(300);
    await expect(page.getByText(/first task is due.*Sep 6.*last.*Sep 16/)).toBeVisible();
    await page.getByRole('button', { name: 'Create 3 tasks', exact: true }).click();
    await page.waitForTimeout(900);

    // The rebuilt shape: same spacing, and every reference pointing at the NEW
    // tasks rather than the originals.
    const rebuilt = await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('taskflow:v1:tasks') || '[]');
      const byId = new Map(all.map((t) => [t.id, t]));
      return all
        .filter((t) => t.title.startsWith('TPLSRC') && !t.id.startsWith('tplsrc_'))
        .map((t) => ({
          title: t.title,
          dueDate: t.dueDate,
          parent: t.parentId ? byId.get(t.parentId)?.title ?? 'MISSING' : null,
          deps: (t.dependsOn || []).map((d) => byId.get(d)?.title ?? 'MISSING'),
        }));
    });
    expect(rebuilt).toHaveLength(3);
    const byTitle = Object.fromEntries(rebuilt.map((t) => [t.title, t]));
    expect(byTitle['TPLSRC Ship it'].dueDate).toBe('2027-09-06');
    expect(byTitle['TPLSRC Draft notes'].dueDate).toBe('2027-09-09');
    expect(byTitle['TPLSRC Review notes'].dueDate).toBe('2027-09-16');
    expect(byTitle['TPLSRC Draft notes'].parent).toBe('TPLSRC Ship it');
    expect(byTitle['TPLSRC Ship it'].parent).toBeNull();
    // The dependency must resolve to the NEW draft, not the seeded one.
    expect(byTitle['TPLSRC Review notes'].deps).toEqual(['TPLSRC Draft notes']);

    expectNoErrors(errors);
  });

  test('the picker explains how to make one when there are none, and lists them alphabetically', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    async function openPicker() {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Control+K');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await expect(palette).toBeVisible();
      await page.getByLabel('Command palette search').fill('template');
      await page.waitForTimeout(300);
      await palette.getByRole('option', { name: 'New from template' }).click();
      await page.waitForTimeout(400);
    }

    // Empty state teaches the only route in — there is no other way to make one.
    await openPicker();
    await expect(page.getByText(/Save as template/)).toBeVisible();
    await closeAnyModal(page);

    await page.evaluate(() => {
      localStorage.setItem('taskflow:v1:taskTemplates', JSON.stringify([
        { id: 'b', name: 'Zebra process', createdAt: 2, tasks: [{ localId: 'z', title: 'Z', dueDayOffset: 0, parentLocalId: null, dependsOnLocalIds: [] }] },
        { id: 'a', name: 'Aardvark process', createdAt: 1, tasks: [{ localId: 'a', title: 'A', dueDayOffset: null, parentLocalId: null, dependsOnLocalIds: [] }] },
      ]));
    });
    await page.reload();
    await gotoTab(page, 'Tasks');
    await page.waitForTimeout(500);

    await openPicker();
    // Alphabetical, not by creation order — a list you search by name
    // shouldn't reorder itself (same rule as saved views and the sidebar).
    await expect(page.locator('.template-row-name')).toHaveText(['Aardvark process', 'Zebra process']);
    // An undated template says so rather than implying dates it doesn't have.
    await expect(page.getByText('1 task, no due dates')).toBeVisible();

    expectNoErrors(errors);
  });
});
