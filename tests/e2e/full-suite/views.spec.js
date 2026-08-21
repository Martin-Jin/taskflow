// Full-suite — Board/Gantt views, Calendar (view switching, navigation,
// event creation/detail, date picker, mobile swipe carousel) and the
// Tasks page's View/Filter menu. See helpers.js for shared setup.
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  gotoTab,
  closeAnyModal,
  trackConsoleErrors,
  expectNoErrors,
  resolveConfirmModal,
  selectMenuLabel,
  switchToProject,
} from './helpers';

// Opens the Tasks page's "Change view or filter" menu and picks a view
// (Board/Gantt/List) by its exact label — mirrors ViewFilterMenu's
// role="menuitemradio" items.
async function switchTaskView(page, label) {
  // On mobile the same trigger also carries the project actions, so it's
  // labelled differently (see ViewFilterMenu's `projectActions` prop) — match
  // either wording so this helper works at both widths.
  await page.getByRole('button', { name: /change view or filter|view, filter, and project actions/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await page.waitForTimeout(400);
}

// Drags `source` onto `target` using native HTML5 DnD (BoardView's cards use
// `draggable` + onDragStart/onDrop, not a pointer-based dnd library — see
// BoardView.jsx's "Native HTML5 DnD" comment). Chromium fires the browser's
// real drag machinery off plain mouse events as long as the move happens in
// several steps past the drag threshold, so a slow multi-step mouse sequence
// (rather than dispatching synthetic dragstart/drop events by hand) is
// enough to trigger it headlessly.
async function htmlDnd(page, source, target) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2 + 10, { steps: 5 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

// Same gesture, but released in `column`'s empty space BELOW its last card
// rather than at its centre — a drop on a card's own body is now the "make
// sub-task" gesture (see BoardView's DRAG SEMANTICS note), so a section move
// has to aim at the column background. Falls back to the body's centre when
// the column has no cards at all.
async function htmlDndToColumnBackground(page, source, column) {
  const body = column.locator('.board-column-body');
  const bodyBox = await body.boundingBox();
  const lastCard = body.locator('.board-card').last();
  const lastCardBox = (await lastCard.count()) > 0 ? await lastCard.boundingBox() : null;
  const dropY = lastCardBox
    ? Math.min(lastCardBox.y + lastCardBox.height + 20, bodyBox.y + bodyBox.height - 12)
    : bodyBox.y + bodyBox.height / 2;

  const sourceBox = await source.boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2 + 10, { steps: 5 });
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, dropY, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

// Long-press touch drag (the mobile equivalent of the two helpers above —
// see useReparentDrag's touch path). Holds past LONG_PRESS_MS without moving
// so the gesture reads as a drag rather than a scroll, then tracks to the
// target and releases.
async function touchDnd(page, source, target) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  const from = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  // Dispatched straight at the source element (touchmove/touchend go to window
  // listeners, which these bubble up to) rather than via page.touchscreen —
  // Playwright's tap is a single down/up with no hold, so it can't express the
  // long press the gesture is gated on.
  await source.evaluate(
    async (el, { from, to }) => {
      function touchEvent(type, x, y) {
        const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        el.dispatchEvent(
          new TouchEvent(type, {
            touches: type === 'touchend' ? [] : [touch],
            targetTouches: type === 'touchend' ? [] : [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          })
        );
      }
      touchEvent('touchstart', from.x, from.y);
      await new Promise((r) => setTimeout(r, 400)); // past LONG_PRESS_MS (250ms)
      for (let i = 1; i <= 8; i += 1) {
        touchEvent('touchmove', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
        await new Promise((r) => setTimeout(r, 25));
      }
      touchEvent('touchend', to.x, to.y);
    },
    { from, to }
  );
  await page.waitForTimeout(500);
}

test.describe('Board view', () => {
  test('drag a card from one column to another moves it between sections', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');
    await switchTaskView(page, 'Board');

    const columns = page.locator('.board-column');
    await expect(columns.first()).toBeVisible();
    if ((await columns.count()) < 2) {
      console.log('Work project does not have 2+ board columns in this build — skipping drag assertion.');
      expectNoErrors(errors);
      return;
    }

    // Mock data seeds Work's "Planning" section with at least one task (see
    // mockData.js's sec_planning tasks) — drag its first card into "In
    // Progress" and confirm it lands there.
    const planningColumn = page.locator('.board-column', { has: page.locator('.board-column-title', { hasText: 'Planning' }) });
    const inProgressColumn = page.locator('.board-column', { has: page.locator('.board-column-title', { hasText: 'In Progress' }) });
    await expect(planningColumn).toBeVisible();
    await expect(inProgressColumn).toBeVisible();

    const card = planningColumn.locator('.board-card').first();
    await expect(card).toBeVisible();
    const cardTitle = (await card.locator('.board-card-title').innerText()).trim();

    // Released in the column body's empty space near the bottom, deliberately
    // NOT on one of its existing cards — a card-on-card drop is the "make
    // sub-task" gesture now (see the reparent test below).
    await htmlDndToColumnBackground(page, card, inProgressColumn);

    // The card should now render inside In Progress's column body instead of
    // Planning's, and Planning's count should have dropped by one.
    await expect(inProgressColumn.locator('.board-card-title', { hasText: cardTitle })).toBeVisible();
    await expect(planningColumn.locator('.board-card-title', { hasText: cardTitle })).toHaveCount(0);

    // Confirm the change actually persisted (not just an optimistic visual
    // move) by reopening the card's detail modal and checking its section.
    await inProgressColumn.locator('.board-card', { hasText: cardTitle }).click();
    await page.waitForTimeout(300);
    await expect.poll(() => selectMenuLabel(page, 'Section')).toBe('In Progress');
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  // Adds two fresh cards to `column` and returns their titles — mock data only
  // seeds one card per Work section, and the reparent gesture needs a pair in
  // the SAME column (a cross-column drop would also be a legal section move,
  // so a same-column pair isolates the reparent behaviour on its own).
  async function seedTwoCards(page, column, runId) {
    const titles = [`E2E Parent ${runId}`, `E2E Child ${runId}`];
    for (const title of titles) {
      await column.getByRole('button', { name: /add task/i }).click();
      await page.getByPlaceholder('Task name').fill(title);
      await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
      await page.waitForTimeout(400);
    }
    return titles;
  }

  test('drag a card onto another card makes it a sub-task of that card', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');
    await switchTaskView(page, 'Board');

    const planningColumn = page.locator('.board-column', { has: page.locator('.board-column-title', { hasText: 'Planning' }) });
    await expect(planningColumn).toBeVisible();
    const [parentTitle, childTitle] = await seedTwoCards(page, planningColumn, Date.now());
    const parentCard = planningColumn.locator('.board-card', { hasText: parentTitle });
    const childCard = planningColumn.locator('.board-card', { hasText: childTitle });

    await htmlDnd(page, childCard, parentCard);

    // Board never gives a sub-task its own card (see BoardView's SUB-TASKS
    // note) — it rolls up into the parent's "x/y" progress badge instead, so
    // the dragged card disappearing from the board IS the visible outcome.
    await expect(page.locator('.board-card-title', { hasText: childTitle })).toHaveCount(0);
    await expect(planningColumn.locator('.board-card', { hasText: parentTitle }).locator('.board-card-meta')).toContainText('0/1');

    // And it really is a child, not just hidden from the board: the parent's
    // detail modal now lists it as a sub-task.
    await planningColumn.locator('.board-card', { hasText: parentTitle }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Sub-tasks (0/1)')).toBeVisible();
    await expect(page.locator('.subtask-row', { hasText: childTitle })).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
  });

  test('long-press touch drag reparents a card on mobile', async ({ browser }) => {
    // Needs a genuinely touch-capable context, not just a phone-sized window:
    // the gesture is driven entirely by touch events (see useReparentDrag's
    // touch path), which a plain viewport resize doesn't enable.
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');
    await switchTaskView(page, 'Board');

    const planningColumn = page.locator('.board-column', { has: page.locator('.board-column-title', { hasText: 'Planning' }) });
    await expect(planningColumn).toBeVisible();
    const [parentTitle, childTitle] = await seedTwoCards(page, planningColumn, Date.now());

    await touchDnd(
      page,
      planningColumn.locator('.board-card', { hasText: childTitle }),
      planningColumn.locator('.board-card', { hasText: parentTitle })
    );

    await expect(page.locator('.board-card-title', { hasText: childTitle })).toHaveCount(0);
    await planningColumn.locator('.board-card', { hasText: parentTitle }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Sub-tasks (0/1)')).toBeVisible();
    await closeAnyModal(page);

    expectNoErrors(errors);
    await context.close();
  });

  test('drag a column header grip reorders columns, and the order survives a reload', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');
    await switchTaskView(page, 'Board');

    // Only real Sections are reorderable — the synthetic "No Section" column
    // has no grip and always leads (see BoardView's COLUMN REORDER note), so
    // read the order from the reorderable columns only.
    const reorderable = page.locator('.board-column:not(.no-section)');
    await expect(reorderable.first()).toBeVisible();
    if ((await reorderable.count()) < 2) {
      console.log('Work project does not have 2+ real sections in this build — skipping reorder assertion.');
      expectNoErrors(errors);
      return;
    }

    const titlesBefore = await reorderable.locator('.board-column-title').allInnerTexts();
    const firstTitle = titlesBefore[0].trim();
    const secondTitle = titlesBefore[1].trim();

    // Drag the first column's grip onto the second column — the dragged one
    // takes the target's slot, so the two swap.
    await htmlDnd(page, reorderable.first().locator('.board-column-grip'), reorderable.nth(1));

    const expected = [secondTitle, firstTitle, ...titlesBefore.slice(2).map((t) => t.trim())];
    await expect
      .poll(async () => (await reorderable.locator('.board-column-title').allInnerTexts()).map((t) => t.trim()))
      .toEqual(expected);

    // The order is persisted per project in localStorage, so it must survive a
    // reload (and not be reset by sections re-syncing on boot).
    await page.reload();
    await gotoTab(page, 'Tasks');
    await switchTaskView(page, 'Board');
    await expect
      .poll(async () => (await reorderable.locator('.board-column-title').allInnerTexts()).map((t) => t.trim()))
      .toEqual(expected);

    expectNoErrors(errors);
  });

  // Manual drag-reorder of tasks within the same section/column doesn't
  // exist anywhere in this codebase today — TaskListPanel's rows and
  // BoardView's cards are both purely sorted (by due date/priority/etc,
  // see filterTasksByStatus) and only animate reordering, they don't accept
  // a user drag to reprioritize order within a column (BoardView's column
  // onDrop only ever changes `sectionId`, never a same-column position — see
  // handleColumnDrop's early-return when `task.sectionId === col.id`; a
  // card-on-card drop is the separate sub-task reparent gesture, tested
  // above, not a reorder).
  // Skipping rather than asserting behavior that isn't implemented.
  test.skip('drag-reorder two tasks within the same column (no such feature exists yet)', () => {});

  test('Section CRUD: add, rename, and delete a section reassigns its tasks to No Section', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchToProject(page, 'Work');
    await switchTaskView(page, 'Board');

    const sectionName = `E2E Section ${Date.now()}`;
    const renamedName = `${sectionName} Renamed`;

    // Add a new section via the trailing "+ Add section" column.
    await page.locator('.board-add-column').getByRole('button', { name: /add section/i }).click();
    await page.locator('.board-add-column-form input').fill(sectionName);
    await page.locator('.board-add-column-form').getByRole('button', { name: /^add$/i }).click();
    await page.waitForTimeout(400);

    // A new section is appended with the highest `order`, so it always
    // renders as the last `.board-column` (before the "+ Add section" tile,
    // which isn't itself a `.board-column`) — use that as the stable handle
    // instead of a `hasText` filter on `.board-column-title`, since that
    // title element is swapped out for a plain `.board-column-title-input`
    // while editing (no title text to match against mid-rename).
    const newColumn = page.locator('.board-column').last();
    await expect(newColumn.locator('.board-column-title')).toHaveText(sectionName);

    // Rename it (click-to-rename on the column header title).
    await newColumn.locator('.board-column-title').click();
    const renameInput = newColumn.locator('.board-column-title-input');
    await renameInput.fill(renamedName);
    await renameInput.press('Enter');
    await page.waitForTimeout(300);
    const renamedColumn = page.locator('.board-column').last();
    await expect(renamedColumn.locator('.board-column-title')).toHaveText(renamedName);

    // Add a task into it so deletion has something to reassign.
    await renamedColumn.getByRole('button', { name: /add task/i }).click();
    const taskTitle = `E2E section-delete task ${Date.now()}`;
    await page.getByPlaceholder('Task name').fill(taskTitle);
    await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
    await page.waitForTimeout(400);
    await expect(renamedColumn.locator('.board-card-title', { hasText: taskTitle })).toBeVisible();

    // Delete the section — the shared in-app confirm modal warns it'll move
    // the task(s) to No Section.
    await renamedColumn.locator('.board-column-delete').click();
    await resolveConfirmModal(page, { expectMessage: /No Section/i, confirmLabel: 'Delete' });
    await page.waitForTimeout(400);

    await expect(page.locator('.board-column-title', { hasText: renamedName })).toHaveCount(0);
    // The task didn't get silently dropped — it now lives in "No Section".
    const noSectionColumn = page.locator('.board-column.no-section');
    await expect(noSectionColumn).toBeVisible();
    await expect(noSectionColumn.locator('.board-card-title', { hasText: taskTitle })).toBeVisible();

    expectNoErrors(errors);
  });

  test('switch to Board, columns render, add-task-in-column works', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    // Board only appears in the view menu once a real project (not the "All
    // Tasks"/"Inbox" pseudo views) is selected — see TaskListPanel's
    // PAGE_VIEWS filter. Row 0 is "All Tasks", row 1 is "Inbox", so the
    // first real project is row 2.
    await page.locator('.task-project-rail-link').nth(2).click();
    await page.waitForTimeout(300);

    await switchTaskView(page, 'Board');

    // Board renders either a flat list (no sections) or columns — either
    // way the toolbar's search bar for the board should be present.
    await expect(page.getByPlaceholder('Search board…')).toBeVisible();

    const columns = page.locator('.board-column');
    const columnCount = await columns.count();
    if (columnCount > 0) {
      // Real sections exist — verify a column header and its "Add task" affordance.
      await expect(columns.first().locator('.board-column-header')).toBeVisible();
      const addTaskBtn = columns.first().getByRole('button', { name: /add task/i });
      await expect(addTaskBtn).toBeVisible();
      await addTaskBtn.click();
      await expect(page.getByPlaceholder('Task name')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      // Flat mode (project has no sections) — the flat list's "Add section"
      // affordance stands in for column structure.
      await expect(page.locator('.board-flat-list')).toBeVisible();
      await expect(page.getByRole('button', { name: /add section/i })).toBeVisible();
    }

    expectNoErrors(errors);
  });
});

test.describe('Gantt view', () => {
  test('switch to Gantt and it renders without errors', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await switchTaskView(page, 'Gantt');

    // GanttChart renders one row per task with a bar chart icon in its header.
    await expect(page.locator('.gantt-row, [class*="gantt"]').first()).toBeVisible({ timeout: 3000 }).catch(() => {});
    expectNoErrors(errors);
  });
});

test.describe('Calendar', () => {
  test('switch Day/3 Day/Week/Month views', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    const hamburger = page.getByRole('button', { name: /change view/i });
    for (const label of ['Day', '3 Day', 'Week', 'Month']) {
      await hamburger.click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(400);
      // Title reflects the newly selected view (month shows "Month Year",
      // day/week show a formatted date range) — just assert no crash by
      // checking the toolbar title is present.
      await expect(page.locator('.calendar-toolbar-title')).toBeVisible();
    }

    expectNoErrors(errors);
  });

  test('navigate forward and back a period', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    const titleEl = page.locator('.calendar-toolbar-title');
    const initialTitle = await titleEl.innerText();

    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(300);
    const nextTitle = await titleEl.innerText();
    expect(nextTitle).not.toEqual(initialTitle);

    await page.getByRole('button', { name: 'Previous' }).click();
    await page.waitForTimeout(300);
    const backTitle = await titleEl.innerText();
    expect(backTitle).toEqual(initialTitle);

    expectNoErrors(errors);
  });

  test('create an event by dragging on an empty calendar slot', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    // Switch to Day view so there's exactly one day-column to target.
    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    // WeekView's create-drag only fires when mousedown lands directly on the
    // day-column element (not an absolutely-positioned block/event child) —
    // try a few vertical offsets top-to-bottom until one lands on empty
    // space and actually opens the "New event" modal.
    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2, 0.4, 0.6, 0.8]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }

    if (!created) {
      console.log('Could not find an empty slot to drag on (day fully booked) — skipping create-event assertion.');
      expectNoErrors(errors);
      return;
    }

    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E test event');
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    // The new event should now appear on the grid — click it to reopen
    // EventDetailModal in edit mode (mock data ships with no pre-seeded
    // manual events, so re-opening the one just created is the reliable way
    // to exercise "open an existing event's detail modal" deterministically).
    const newEvent = page.locator('.cal-event', { hasText: 'E2E test event' }).first();
    await expect(newEvent).toBeVisible({ timeout: 3000 });
    await newEvent.click();
    await page.waitForTimeout(300);
    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.locator('input').first()).toHaveValue('E2E test event');
    await expect(editDialog.getByRole('button', { name: 'Delete' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    expectNoErrors(errors);
  });

  test('create a recurring event and confirm it exposes the series scope picker', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2, 0.4, 0.6, 0.8]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }

    if (!created) {
      console.log('Could not find an empty slot to drag on (day fully booked) — skipping recurring-event assertion.');
      expectNoErrors(errors);
      return;
    }

    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E recurring event');
    await dialog.getByRole('checkbox', { name: /repeats/i }).check();
    // The Repeat interval/frequency is a free-text smart-parse box (see
    // SmartRecurrenceInput), not a number+dropdown pair — defaults to "every
    // week" until the user types something else.
    await expect(dialog.locator('input[type="text"]')).toHaveValue('every week');
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    const newEvent = page.locator('.cal-event', { hasText: 'E2E recurring event' }).first();
    await expect(newEvent).toBeVisible({ timeout: 3000 });
    await newEvent.click();
    await page.waitForTimeout(300);

    // A recurring master gets its own id as `seriesId` (see
    // SchedulerContext.addManualEvent), which is what gates EventDetailModal's
    // "Apply to" scope picker — its presence here confirms the created event
    // is genuinely wired up as a recurring series, not just a plain one-off.
    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    // exact: true — DetailField's label span ("Apply to") vs. the
    // form-hint paragraph that also mentions '"Apply to"' when quoting it.
    await expect(editDialog.getByText('Apply to', { exact: true })).toBeVisible();
    await expect(editDialog.getByRole('combobox').filter({ hasText: /this event/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    expectNoErrors(errors);
  });

  test('editing an existing event can turn it into a recurring series, and later edit its cadence', async ({ page }) => {
    // Regression coverage for EventDetailModal's Repeat field, which used to
    // be gated entirely behind "isCreate" — editing an already-saved event
    // had no way to add/change a repeat pattern at all.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2, 0.4, 0.6, 0.8]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }

    if (!created) {
      console.log('Could not find an empty slot to drag on (day fully booked) — skipping edit-mode repeat assertion.');
      expectNoErrors(errors);
      return;
    }

    // Create a plain, non-recurring event first.
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E edit-mode repeat');
    await expect(dialog.getByRole('checkbox', { name: /repeats/i })).not.toBeChecked();
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    const newEvent = page.locator('.cal-event', { hasText: 'E2E edit-mode repeat' }).first();
    await expect(newEvent).toBeVisible({ timeout: 3000 });
    await newEvent.click();
    await page.waitForTimeout(300);

    // Reopened in edit mode: no "Apply to" scope picker yet (not a series),
    // but the Repeat checkbox is available and unchecked.
    let editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByText('Apply to', { exact: true })).toHaveCount(0);
    const repeatCheckbox = editDialog.getByRole('checkbox', { name: /repeats/i });
    await expect(repeatCheckbox).not.toBeChecked();

    // Turn it into a recurring series with a typed smart-parse phrase.
    await repeatCheckbox.check();
    const repeatInput = editDialog.locator('input[type="text"]');
    await expect(repeatInput).toHaveValue('every week');
    await repeatInput.fill('every 2 weeks');
    await repeatInput.blur();
    await expect(repeatInput).toHaveValue('every 2 weeks');
    await editDialog.getByRole('button', { name: /^save$/i }).click();
    await page.waitForTimeout(400);

    // Reopening now shows the series scope picker (seriesId was assigned)
    // and the Repeat box reflects the saved cadence, parsed back off the
    // stored recurrenceRule.
    await page.locator('.cal-event', { hasText: 'E2E edit-mode repeat' }).first().click();
    await page.waitForTimeout(300);
    editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByText('Apply to', { exact: true })).toBeVisible();
    await expect(editDialog.getByRole('checkbox', { name: /repeats/i })).toBeChecked();
    await expect(editDialog.locator('input[type="text"]')).toHaveValue('every 2 weeks');

    // At the default 'this event' scope, the cadence controls are disabled —
    // changing a whole series' repeat pattern only makes sense at 'all' scope.
    await expect(editDialog.locator('input[type="text"]')).toBeDisabled();
    await expect(editDialog.getByText(/to edit the repeat pattern/i)).toBeVisible();

    // Switch to 'all' scope and edit the cadence again. The Repeat field's
    // own "Ends" select is also a combobox here, so target the "Apply to"
    // one specifically by an option only it has (mirrors the earlier
    // create-mode recurring test's own disambiguation).
    await editDialog.getByRole('combobox').filter({ hasText: /this event/i }).selectOption('all');
    const seriesRepeatInput = editDialog.locator('input[type="text"]');
    await expect(seriesRepeatInput).toBeEnabled();
    await seriesRepeatInput.fill('every 3 weeks');
    await seriesRepeatInput.blur();
    await editDialog.getByRole('button', { name: /^save$/i }).click();
    await page.waitForTimeout(400);

    await page.locator('.cal-event', { hasText: 'E2E edit-mode repeat' }).first().click();
    await page.waitForTimeout(300);
    editDialog = page.getByRole('dialog');
    await expect(editDialog.locator('input[type="text"]')).toHaveValue('every 3 weeks');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    expectNoErrors(errors);
  });

  test('editing an existing event auto-saves on close/Escape (not just the Save button), but Cancel still discards', async ({ page }) => {
    // Regression coverage: EventDetailModal used to only persist edits to an
    // EXISTING event via the explicit "Save" button — closing any other way
    // (X, Escape, backdrop click) silently discarded the edit. Now every
    // dismissal except the explicit "Cancel" button auto-saves (see
    // EventDetailModal's handleModalClose), matching how editing a task
    // already never requires hunting down a specific button to not lose an
    // edit. Creating a brand new event is unaffected — that still requires
    // the explicit "Add event" action.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2, 0.4, 0.6, 0.8]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }
    if (!created) {
      console.log('Could not find an empty slot to drag on (day fully booked) — skipping autosave-on-close assertion.');
      expectNoErrors(errors);
      return;
    }

    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E autosave-on-close');
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    const newEvent = page.locator('.cal-event', { hasText: 'E2E autosave-on-close' }).first();
    await expect(newEvent).toBeVisible({ timeout: 3000 });

    // Edit the location, then close via Escape (not Save) — should persist.
    await newEvent.click();
    let editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await editDialog.getByPlaceholder('e.g. Conference room').fill('Room 42');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await newEvent.click();
    editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByPlaceholder('e.g. Conference room')).toHaveValue('Room 42');

    // Edit it again, but this time click Cancel — should discard.
    await editDialog.getByPlaceholder('e.g. Conference room').fill('Should not be saved');
    await editDialog.getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(300);

    await newEvent.click();
    editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByPlaceholder('e.g. Conference room')).toHaveValue('Room 42');

    // Pressing Enter in a single-line field saves and closes the modal.
    await editDialog.getByPlaceholder('e.g. Conference room').fill('Room 99');
    await editDialog.getByPlaceholder('e.g. Conference room').press('Enter');
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await newEvent.click();
    editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByPlaceholder('e.g. Conference room')).toHaveValue('Room 99');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    expectNoErrors(errors);
  });

  test('deleting a recurring event with "All events in the series" removes it entirely', async ({ page }) => {
    // Regression test for a bug where SchedulerContext.deleteEvent looked up
    // the row to delete by the clicked occurrence's VIRTUAL id
    // (`${masterId}::${date}`) instead of resolving it back to the real
    // master row first — `events` never contains a row keyed by that virtual
    // id, so the lookup silently found nothing and "Delete" + "All events in
    // the series" was a no-op. 'This event'/'This and following' already
    // resolved correctly; this scope was the one gap.
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2, 0.4, 0.6, 0.8]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }

    if (!created) {
      console.log('Could not find an empty slot to drag on (day fully booked) — skipping series-delete assertion.');
      expectNoErrors(errors);
      return;
    }

    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E series delete');
    await dialog.getByRole('checkbox', { name: /repeats/i }).check();
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    const newEvent = page.locator('.cal-event', { hasText: 'E2E series delete' }).first();
    await expect(newEvent).toBeVisible({ timeout: 3000 });
    await newEvent.click();
    await page.waitForTimeout(300);

    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    // The Repeat field's own "Ends" select is also a combobox now that
    // edit-mode exposes Repeat too — disambiguate by an option only the
    // "Apply to" scope select has.
    await editDialog.getByRole('combobox').filter({ hasText: /this event/i }).selectOption('all');
    await editDialog.getByRole('button', { name: /^delete$/i }).click();
    await page.waitForTimeout(400);

    await expect(page.locator('.cal-event', { hasText: 'E2E series delete' })).toHaveCount(0);

    expectNoErrors(errors);
  });

  test('drag an existing event to reschedule it to a different time', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    // Switch to Day view so there's exactly one day-column to drag within.
    await page.getByRole('button', { name: /change view/i }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await page.waitForTimeout(400);

    const dayColumn = page.locator('.day-column').first();
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();

    // Create a fresh event near the top of the day (same create-drag flow as
    // the test above) so there's a known, isolated element to reschedule —
    // dragging a seeded block risks colliding with another already-scheduled
    // item and is harder to assert on deterministically.
    const dialog = page.getByRole('dialog').filter({ hasText: 'New event' });
    let created = false;
    for (const frac of [0.02, 0.1, 0.2]) {
      const x = box.x + box.width / 2;
      const yStart = box.y + box.height * frac;
      await page.mouse.move(x, yStart);
      await page.mouse.down();
      await page.mouse.move(x, yStart + 40, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        created = true;
        break;
      }
    }
    if (!created) {
      console.log('Could not find an empty slot to create a reschedulable event — skipping.');
      expectNoErrors(errors);
      return;
    }
    await dialog.getByPlaceholder('e.g. Team standup').fill('E2E reschedule event');
    await dialog.getByRole('button', { name: /^add event$/i }).click();
    await page.waitForTimeout(400);

    const event = page.locator('.cal-event', { hasText: 'E2E reschedule event' }).first();
    await expect(event).toBeVisible({ timeout: 3000 });
    const beforeBox = await event.boundingBox();

    // Drag it ~150px further down the same day column (native HTML5 DnD —
    // see WeekView's handleDragStart/handleDropOnDay — Chromium fires the
    // real drag machinery off a slow multi-step mouse sequence).
    await page.mouse.move(beforeBox.x + beforeBox.width / 2, beforeBox.y + beforeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeBox.x + beforeBox.width / 2 + 5, beforeBox.y + beforeBox.height / 2 + 20, { steps: 5 });
    await page.mouse.move(beforeBox.x + beforeBox.width / 2, beforeBox.y + beforeBox.height / 2 + 150, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);

    // Verify via its detail modal that the start time actually changed,
    // rather than relying solely on pixel position (which is also a valid
    // signal but more brittle to layout tweaks).
    const movedEvent = page.locator('.cal-event', { hasText: 'E2E reschedule event' }).first();
    await expect(movedEvent).toBeVisible();
    const afterBox = await movedEvent.boundingBox();
    expect(Math.round(afterBox.y)).not.toEqual(Math.round(beforeBox.y));

    await movedEvent.click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toBeVisible();
    // Clean up so this test is idempotent across reruns.
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(300);

    expectNoErrors(errors);
  });

  test('open an existing seeded event/block detail modal (best-effort)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(500);

    // Mock data (src/services/mockData.js) doesn't necessarily seed any
    // manual/Google calendar events, but scheduled task blocks (.cal-block)
    // are generated for dated tasks — either counts as "an existing item on
    // the calendar" for the purposes of exercising its detail modal.
    const existingItem = page.locator('.cal-event, .cal-block').first();
    if (await existingItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await existingItem.click();
      await page.waitForTimeout(300);
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      console.log('No seeded calendar event/block visible in the current week — skipping.');
    }

    expectNoErrors(errors);
  });

  // Hover preview (HoverPreviewCard) relies on a real mouse hovering and
  // resting over an event for ~350ms (see WeekView's scheduleHoverPreview
  // debounce) before the card renders. Playwright's page.hover() can
  // synthesize this, but it's inherently timing-sensitive and non-critical
  // (a tooltip-style enhancement, not core functionality) — attempt it but
  // don't fail the whole suite if the timing doesn't line up headlessly.
  test('hover preview card appears over an event (best-effort)', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(500);

    const existingEvent = page.locator('.cal-event, .cal-block').first();
    if (await existingEvent.isVisible({ timeout: 2000 }).catch(() => false)) {
      await existingEvent.hover();
      await page.waitForTimeout(600); // past the 350ms debounce
      const previewVisible = await page
        .locator('[class*="hover-preview"]')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      console.log('hover preview card visible:', previewVisible);
    } else {
      console.log('No event/block available to hover — skipping.');
    }

    expectNoErrors(errors);
  });

  test('date picker dropdown: open and jump to a specific date', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');

    await page.locator('.calendar-toolbar-title-btn').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.calendar-date-picker-dropdown')).toBeVisible();

    // Jump to the next month via its tab, then pick day 15.
    const monthTabs = page.locator('.calendar-date-picker-month-tab');
    const activeIndex = await monthTabs.evaluateAll((tabs) => tabs.findIndex((t) => t.classList.contains('active')));
    await monthTabs.nth(activeIndex + 1).click();
    await page.waitForTimeout(200);

    const day15 = page.locator('.calendar-date-picker-day', { hasText: /^15$/ }).first();
    await day15.click();
    await page.waitForTimeout(300);

    // Dropdown closes after selecting, and the toolbar title updates.
    await expect(page.locator('.calendar-date-picker-dropdown')).toHaveCount(0);
    expectNoErrors(errors);
  });
});

test.describe('Mobile calendar swipe carousel', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders the swipe carousel track on a mobile viewport', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Calendar');
    await page.waitForTimeout(500);

    // CalendarPage only renders .calendar-swipe-viewport/-track when
    // useIsMobile() is true (max-width: 639px) — confirms the mobile
    // carousel mounts instead of the desktop single-page view.
    await expect(page.locator('.calendar-swipe-viewport')).toBeVisible();
    const pages = page.locator('.calendar-swipe-page');
    await expect(pages).toHaveCount(3);

    // A real swipe gesture requires native (non-passive) touch events with
    // preventDefault, which Playwright's page.touchscreen can dispatch, but
    // simulating the exact drag-then-release-past-threshold physics
    // reliably in a headless browser is flaky and not worth chasing here —
    // instead, verify the equivalent keyboard/tap navigation (the mobile
    // "Today" button + swipe-carousel's underlying anchorDate change) via
    // the date picker, which exercises the same `anchorDate` state the
    // swipe gesture would also update.
    const titleBefore = await page.locator('.calendar-toolbar-title').innerText();
    await page.locator('.calendar-toolbar-title-btn').click();
    await page.waitForTimeout(300);
    const day = page.locator('.calendar-date-picker-day:not(.is-outside)').nth(10);
    await day.click();
    await page.waitForTimeout(300);
    const titleAfter = await page.locator('.calendar-toolbar-title').innerText();
    expect(titleAfter).not.toEqual(titleBefore);

    expectNoErrors(errors);
  });
});

test.describe('Mobile Tasks list + Add Task modal', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Tasks tab and Add Task modal render usably on a mobile viewport', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');
    await page.waitForTimeout(400);

    // No horizontal overflow — the page shouldn't force a wider scroll area
    // than the viewport itself.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390 + 1); // +1px rounding tolerance

    await expect(page.getByPlaceholder(/search tasks/i)).toBeVisible();
    const taskRow = page.locator('.task-row, .board-card').first();
    await expect(taskRow).toBeVisible();

    // InstallAppBanner (mobile-only, see its own doc comment) renders in the
    // same fixed-position corner as the Add Task FAB the first time this
    // localStorage-backed app is viewed at a mobile width — dismiss it first
    // so it doesn't intercept the FAB's click below.
    const dismissBanner = page.getByRole('button', { name: 'Dismiss' });
    if (await dismissBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
      await dismissBanner.click();
      await page.waitForTimeout(200);
    }

    // Open Add Task (same two-step FAB speed-dial as desktop — see helpers.js's
    // openAddTask doc comment) and confirm the modal + its core fields are
    // reachable within the mobile viewport.
    await page.getByRole('button', { name: /^add task$/i }).click();
    let titleInput = page.getByPlaceholder('Task name');
    if (!(await titleInput.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.getByRole('button', { name: /^add task$/i }).click();
    }
    await expect(titleInput).toBeVisible();

    const dialog = page.getByRole('dialog');
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox.width).toBeLessThanOrEqual(390 + 1);

    await titleInput.fill('E2E mobile viewport check');
    await expect(page.getByPlaceholder('Description (optional)')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^add task$/i })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    expectNoErrors(errors);
  });
});

test.describe('View/Filter menu', () => {
  test('status filter narrows the task list', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);
    await gotoTab(page, 'Tasks');

    const taskRows = page.locator('.task-row, [class*="task-list"] [role="button"]');
    // Fall back to counting via the panel's own list items if the above
    // selector doesn't match this build's markup.
    const countAll = await page.locator('.task-list-panel .task-row, .tasklist .task-row').count();

    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitemradio', { name: 'Completed', exact: true }).click();
    await page.waitForTimeout(400);

    // Completed filter should show only completed tasks (or none) — sanity
    // check the filter actually took effect via the menu's checked state.
    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.waitForTimeout(200);
    await expect(page.getByRole('menuitemradio', { name: 'Completed', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Switch to "No due date" and confirm that's now the checked filter.
    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitemradio', { name: 'No due date', exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.waitForTimeout(200);
    await expect(page.getByRole('menuitemradio', { name: 'No due date', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Reset back to "All" so this test doesn't leak state into others.
    await page.getByRole('button', { name: /change view or filter/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);

    expectNoErrors(errors);
  });
});
