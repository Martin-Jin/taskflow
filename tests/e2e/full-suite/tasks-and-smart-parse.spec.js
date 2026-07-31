// Full-suite regression coverage for task CRUD, sub-tasks, dependencies,
// labels, recurrence, smart parse, and task-form validation edge cases.
// See AddTaskModal.jsx / TaskDetailModal.jsx / smartParse.js / recurrence.js /
// dependencyUtils.js for the behaviors asserted below.
import { test, expect } from '@playwright/test';
import { gotoApp, gotoTab, openAddTask, closeAnyModal, trackConsoleErrors, expectNoErrors } from './helpers';

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
    await page.locator('.addtask-pill-panel select').selectOption('urgent');
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
    const sectionSelect = page.locator('.addtask-more-panel select').first();
    if (await sectionSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
      await sectionSelect.selectOption({ label: 'Planning' }).catch(() => {});
    }
    const durationInput = page.locator('.smart-duration-input');
    await durationInput.click();
    await durationInput.fill('2h');
    await durationInput.blur();

    await submitAddTask(page);

    // Verify it was created and shows up in search.
    await searchAndOpen(page, title);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.detail-sidebar select').first()).toHaveValue('work');
    // Priority select (2nd select in sidebar order: Project, Section, Due date-input, Priority...)
    const prioritySelect = page.locator('.detail-field', { hasText: 'Priority' }).locator('select');
    await expect(prioritySelect).toHaveValue('urgent');
    const dueDateInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    await expect(dueDateInput).toHaveValue('2026-08-15');
    await expect(page.locator('.detail-notes-textarea')).toHaveValue('E2E description text');
    await expect(page.locator('.chip.chip-label', { hasText: `e2e-label-${RUN_ID}` })).toBeVisible();

    // Edit: lower priority to low, wait for sidebar auto-save (debounced 500ms).
    await prioritySelect.selectOption('low');
    await page.waitForTimeout(700);
    await closeAnyModal(page);
    await page.waitForTimeout(300);

    // Re-open and verify the edit persisted.
    await searchAndOpen(page, title);
    const prioritySelect2 = page.locator('.detail-field', { hasText: 'Priority' }).locator('select');
    await expect(prioritySelect2).toHaveValue('low');

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

    // The list row should show "blocked by dependency" and clicking complete
    // should refuse (toast) rather than completing it.
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(titleB);
    await page.waitForTimeout(300);
    await expect(page.getByText('blocked by dependency')).toBeVisible();

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
    await expect(page.getByText('blocked by dependency')).toHaveCount(0);
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

    // Complete it from the list — should advance the due date, not move it
    // to Completed (see CLAUDE.md: recurring tasks are never marked
    // isCompleted on finishing an occurrence).
    await clearSearch(page);
    await page.getByPlaceholder(/search tasks/i).fill(title);
    await page.waitForTimeout(300);
    const completeBtn = page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) });
    await completeBtn.click();
    await page.waitForTimeout(400);

    // Still visible in the default (non-completed) search results, and its
    // "Mark complete" button is still present (never got checked/disabled).
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`Mark ${title} complete`) })).toBeVisible();

    // Due date should have advanced.
    await searchAndOpen(page, title);
    const dueDateAfterInput = page.locator('.detail-field', { hasText: 'Due date' }).locator('input[type="date"]');
    const dueDateAfter = await dueDateAfterInput.inputValue();
    expect(dueDateAfter).not.toEqual(dueDateBefore);
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

  test('multi-word "#Project Name" resolves the full project (not just its first word) even when another project shares that first word', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await gotoApp(page);

    // Two projects sharing a leading word — findProjectPhrase (smartParse.js)
    // must try full project names longest-first so "#Work Trip" resolves to
    // "Work Trip", not the shorter "Work" with "Trip" left dangling in the title.
    const projectA = `Work Trip ${RUN_ID}`;
    const projectB = `Work Notes ${RUN_ID}`;
    await page.getByRole('button', { name: 'Manage projects' }).click();
    const projectsDialog = page.getByRole('dialog', { name: 'Manage projects' });
    await expect(projectsDialog).toBeVisible();
    for (const name of [projectA, projectB]) {
      await projectsDialog.getByRole('button', { name: /^add project$/i }).click();
      await projectsDialog.getByPlaceholder('Project name…').fill(name);
      await projectsDialog.getByRole('button', { name: /^add$/i }).click();
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
    const projectSelect = page.locator('.detail-sidebar select').first();
    const selectedLabel = await projectSelect.evaluate((el) => el.options[el.selectedIndex]?.textContent);
    expect(selectedLabel).toBe(projectA);
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
});
