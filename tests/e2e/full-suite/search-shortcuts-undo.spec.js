// Full-suite — search bar (incl. completed-task hiding), command palette,
// global keyboard shortcuts (undo/redo/new task/command palette), and the
// "@"/"#" mention autocomplete in the task title field.
//
// Seeded data assumed from src/services/mockData.js: task_3 "Refactor auth
// module" (top-level, not recurring, no deps) and the "Work" project — see
// that file if these tests start failing for data reasons rather than code
// reasons. (The Calendar-event search test below seeds its own event
// directly, since the app has no seeded CalendarEvent by default.)
import { test, expect } from '@playwright/test';
import {
  trackConsoleErrors,
  gotoApp,
  gotoTab,
  openAddTask,
  closeAnyModal,
  expectNoErrors,
  chooseSelectMenuOption,
  selectMenuLabel,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test('search bar filters tasks by partial title and clears back to full list', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  const searchInput = page.getByPlaceholder(/search tasks/i);
  const fullCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();
  expect(fullCount).toBeGreaterThan(1);

  // Partial/substring match on the seeded task's title (SearchBar/TaskListPanel
  // use plain substring matching via taskMatchesQuery, not typo-tolerant fuzzy
  // matching — that lives in utils/fuzzyKeyword.js and is only used for smart-
  // parse keyword suggestions, not search).
  await searchInput.fill('auth');
  await page.waitForTimeout(300);
  // Close the SearchBar's own live-suggestion dropdown so the title text
  // below is only matched once, in the actual filtered task list.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).toBeVisible();
  const filteredCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();
  expect(filteredCount).toBeLessThan(fullCount);

  // Clear search restores the full list.
  await page.getByRole('button', { name: /clear search/i }).click();
  await page.waitForTimeout(300);
  await expect(searchInput).toHaveValue('');
  const restoredCount = await page.getByRole('button', { name: /^Mark .* complete$/ }).count();
  expect(restoredCount).toBe(fullCount);

  expectNoErrors(errors);
});

test('search bar surfaces a matching Calendar event and jumps to it on click', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  // The app has no seeded CalendarEvent by default (mock data only seeds
  // tasks/projects/sections/routines — `events` starts as `[]`, see
  // SchedulerContext.jsx), so this test seeds one directly via the same
  // localStorage key the app itself reads on boot (utils/persistence.js's
  // `taskflow:v1:` prefix) and reloads — done after gotoApp's own beforeEach
  // navigation/clear (rather than via another addInitScript) so this write
  // isn't wiped by that clear's own `taskflow:`-prefix sweep.
  await page.evaluate(() => {
    window.localStorage.setItem(
      'taskflow:v1:events',
      JSON.stringify([
        {
          id: 'evt_e2e_dentist',
          title: 'Dentist Appointment',
          date: new Date().toISOString().slice(0, 10),
          startTime: '15:00',
          endTime: '16:00',
          isFreeTime: false,
          isRecurring: false,
          googleEventId: null,
          source: 'manual',
        },
      ])
    );
  });
  await page.reload();
  await gotoTab(page, 'Tasks');

  const searchInput = page.getByPlaceholder(/search tasks/i);
  await searchInput.fill('dentist');
  await page.waitForTimeout(300);

  // The Events group should list the seeded "Dentist Appointment" event.
  const eventsGroup = page.locator('.search-bar-dropdown-group', { hasText: 'Events' });
  await expect(eventsGroup).toBeVisible();
  const eventOption = eventsGroup.getByRole('option', { name: /Dentist Appointment/ });
  await expect(eventOption).toBeVisible();

  await eventOption.click();
  await page.waitForTimeout(400);

  // Clicking navigates to the Calendar tab and opens that event's detail modal.
  await expect(page.getByRole('dialog', { name: /Dentist Appointment/ })).toBeVisible();

  expectNoErrors(errors);
});

test('completed tasks are hidden from search except on the Completed filter', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  // Complete the seeded "Refactor auth module" task via its row checkbox.
  await page.getByRole('button', { name: 'Mark Refactor auth module complete' }).click();
  await page.waitForTimeout(400);

  const searchInput = page.getByPlaceholder(/search tasks/i);
  await searchInput.fill('auth');
  await page.waitForTimeout(300);
  // Close the SearchBar's own dropdown (which has a separate "Show completed
  // tasks" opt-in) so we're checking the main filtered list underneath it,
  // matching TaskListPanel's own hide-completed-during-search behavior.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).not.toBeVisible();

  // Switch to the "Completed" filter (Tasks page's view/filter dropdown) —
  // the task should reappear even with the same search query still active.
  // The fixed-position Add Task FAB (bottom-right, see .add-task-fab-group)
  // now sits over this trigger at rest per the intentional toolbar/header
  // spacing changes, so scroll it into view above the FAB's screen position
  // before clicking, same as a real user would.
  await page.getByRole('button', { name: /change view or filter/i }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /change view or filter/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitemradio', { name: 'Completed' }).click();
  await page.waitForTimeout(300);
  await expect(searchInput).toHaveValue('auth');
  await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).toBeVisible();

  expectNoErrors(errors);
});

test('command palette (Ctrl+K) opens, navigates to a view, and closes', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();

  await page.getByLabel('Command palette search').fill('Calendar');
  await page.waitForTimeout(300);
  // Scoped to the palette itself — "Calendar" also matches the sidebar's own
  // nav tab button underneath, which strict mode would otherwise trip on.
  // Results are role="option" (combobox listbox rows), not "button" — see
  // CommandPalette's aria wiring.
  await palette.getByRole('option', { name: 'Calendar' }).click();
  await page.waitForTimeout(300);

  await expect(palette).not.toBeVisible();
  // Landed on the Calendar tab — the Tasks-only search bar should be gone
  // from the main content area.
  await expect(page.getByPlaceholder(/search tasks/i)).not.toBeVisible();

  expectNoErrors(errors);
});

test('command palette can jump straight to a matching task', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByLabel('Command palette search').fill('Refactor auth');
  await page.waitForTimeout(300);
  // Results are role="option" (combobox listbox rows), not "button" — see
  // CommandPalette's aria wiring.
  await page.getByRole('option', { name: 'Refactor auth module' }).click();
  await page.waitForTimeout(300);

  // Opening a task from the palette shows its detail modal.
  await expect(page.locator('.modal-detail')).toBeVisible();
  await closeAnyModal(page);

  expectNoErrors(errors);
});

test('command palette can jump straight to a matching Calendar event', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  // Same seeding approach as the SearchBar events test above — the app has
  // no seeded CalendarEvent by default, so write one directly to the
  // persistence key and reload before the palette can search it.
  await page.evaluate(() => {
    window.localStorage.setItem(
      'taskflow:v1:events',
      JSON.stringify([
        {
          id: 'evt_e2e_dentist',
          title: 'Dentist Appointment',
          date: new Date().toISOString().slice(0, 10),
          startTime: '15:00',
          endTime: '16:00',
          isFreeTime: false,
          isRecurring: false,
          googleEventId: null,
          source: 'manual',
        },
      ])
    );
  });
  await page.reload();
  await gotoTab(page, 'Dashboard');

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.getByLabel('Command palette search').fill('dentist');
  await page.waitForTimeout(300);
  // Results are role="option" (combobox listbox rows), not "button" — see
  // CommandPalette's aria wiring.
  await palette.getByRole('option', { name: /Dentist Appointment/ }).click();
  await page.waitForTimeout(400);

  await expect(palette).not.toBeVisible();
  // Clicking navigates to the Calendar tab and opens that event's detail modal.
  await expect(page.getByRole('dialog', { name: /Dentist Appointment/ })).toBeVisible();

  expectNoErrors(errors);
});

test('command palette can launch "Quick Add with AI" when configured', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Dashboard');

  // App.jsx's paletteActions gates this action's run() on a stored BYOK key
  // (getStoredApiKey) on top of the isAIQuickAddConfigured() visibility gate
  // below — without a key it shows an error notification instead of opening
  // the modal. Seed a fake key the same way timer-and-ai-quickadd.spec.js does.
  await page.evaluate(() => {
    window.localStorage.setItem('taskflow:v1:aiGeminiApiKey', JSON.stringify('e2e-fake-test-key'));
  });

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();

  await page.getByLabel('Command palette search').fill('Quick Add with AI');
  await page.waitForTimeout(300);
  const action = palette.getByRole('option', { name: 'Quick Add with AI' });
  // Same entry-point gating as the mini-FAB (isAIQuickAddConfigured — see
  // AddTaskFabGroup.jsx/App.jsx's paletteActions): the action is only listed
  // at all when VITE_AI_QUICKADD_WORKER_URL is configured, so skip gracefully
  // like the dedicated AI Quick Add spec does when it isn't.
  const configured = await action.isVisible({ timeout: 1000 }).catch(() => false);
  test.skip(!configured, 'AI Quick Add is not configured locally (VITE_AI_QUICKADD_WORKER_URL unset) — action is intentionally hidden.');

  await action.click();
  await page.waitForTimeout(300);

  await expect(palette).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'AI Quick Add', exact: true })).toBeVisible();
  await closeAnyModal(page);

  expectNoErrors(errors);
});

test('command palette "Add task" does not reopen when revisiting the Tasks tab', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  // Regression test: TaskListPanel/BoardView unmount whenever the user
  // leaves the Tasks tab, so the openAddTaskSignal/openAIQuickAddSignal
  // props they watch must not spuriously reopen the modal on remount just
  // because the signal was already bumped earlier in the session.
  await gotoTab(page, 'Dashboard');

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.getByLabel('Command palette search').fill('Add task');
  await page.waitForTimeout(300);
  await palette.getByRole('option', { name: 'Add task', exact: true }).click();
  await page.waitForTimeout(300);

  await expect(page.getByPlaceholder('Task name')).toBeVisible();
  // Close via the modal's own close button rather than Escape — more
  // deterministic here since this modal was opened through the command
  // palette's own closing modal, which briefly shares the keyboard-handler
  // stack (see useModalA11y) as it animates out.
  await page.getByLabel('Close').first().click();
  await page.waitForTimeout(300);
  await expect(page.getByPlaceholder('Task name')).not.toBeVisible();

  await gotoTab(page, 'Dashboard');
  await gotoTab(page, 'Tasks');
  await page.waitForTimeout(300);
  await expect(page.getByPlaceholder('Task name')).not.toBeVisible();

  expectNoErrors(errors);
});

test('keyboard shortcut: Alt+N opens the "Add task" dialog', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  // TaskListPanel only wires up the newTask signal once it's mounted (see
  // useKeyboardShortcuts' newTask handler in App.jsx, which bumps a signal
  // prop TaskListPanel diffs against on mount) — go to Tasks first so the
  // signal bump this shortcut fires is actually observed as a change.
  await gotoTab(page, 'Tasks');

  await page.keyboard.press('Alt+N');
  await page.waitForTimeout(300);
  await expect(page.getByPlaceholder('Task name')).toBeVisible();
  await closeAnyModal(page);

  expectNoErrors(errors);
});

test('keyboard shortcut: Ctrl+K opens the command palette from any tab', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Stats');

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).not.toBeVisible();

  expectNoErrors(errors);
});

test('keyboard shortcut: Ctrl+Z / Ctrl+Shift+Z undo and redo a task delete', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.modal-detail')).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForTimeout(400);

  // Deleting closes the modal and pops the bottom-corner undo toast.
  await expect(page.locator('.modal-detail')).not.toBeVisible();
  const taskRow = page.locator('.task-row', { hasText: 'Refactor auth module' });
  await expect(taskRow).not.toBeVisible();

  // Undo via the keyboard shortcut (default Ctrl+Z, see useKeyboardShortcuts'
  // SHORTCUT_DEFS) restores the task.
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(400);
  await expect(taskRow).toBeVisible();

  // Redo via the keyboard shortcut (default Ctrl+Shift+Z) re-applies the delete.
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  await expect(taskRow).not.toBeVisible();

  expectNoErrors(errors);
});

test('undo toast: clicking "Undo" on the delete toast restores the task', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForTimeout(400);

  const taskRow = page.locator('.task-row', { hasText: 'Refactor auth module' });
  await expect(taskRow).not.toBeVisible();
  const undoButton = page.locator('.action-toast-undo');
  await expect(undoButton).toBeVisible();
  await undoButton.click();
  await page.waitForTimeout(400);
  await expect(taskRow).toBeVisible();

  expectNoErrors(errors);
});

test('search bar filters by "@label" and matches only tasks carrying that label', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');
  const labelName = `e2esearchlabel${Date.now()}`;

  // Tag the seeded "Refactor auth module" task with a fresh label via its
  // title's "@tag" smart-parse shorthand — taskMatchesQuery (SearchBar.jsx)
  // matches "@tag" search tokens against a task's actual label names, not
  // its title text (see the tagTokens/textTokens split there).
  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  const titleInput = page.locator('.smart-title-input');
  const titleBefore = await titleInput.inputValue();
  await titleInput.fill(`${titleBefore} @${labelName}`);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^save$/i }).click();
  await page.waitForTimeout(400);

  const searchInput = page.getByPlaceholder(/search tasks/i);
  await searchInput.fill(`@${labelName}`);
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); // close SearchBar's own suggestion dropdown
  await page.waitForTimeout(200);
  await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).toBeVisible();

  // An unrelated label token shouldn't match.
  await searchInput.fill('@definitely-not-a-real-label');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('.task-row', { hasText: 'Refactor auth module' })).not.toBeVisible();

  // Clean up: clear search so it doesn't leak into other tests sharing this
  // localStorage-backed app. Note the title itself needs no manual restore —
  // useSmartTaskTitle strips a recognized "@tag" chip's matched text back out
  // of the title on save (it's consumed into labelIds instead), so
  // `task.title` is already back to its original, unlabeled value.
  await searchInput.fill('');
  await page.waitForTimeout(200);

  expectNoErrors(errors);
});

test('undo/redo an edit (priority change), then chains two actions (edit + delete) and unwinds/reapplies both', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');

  // --- Part 1: single edit undo/redo ---------------------------------------
  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  const priorityBefore = await selectMenuLabel(page, 'Priority');
  const priorityAfter = priorityBefore === 'Low' ? 'Urgent' : 'Low';
  await chooseSelectMenuOption(page, 'Priority', priorityAfter);
  await page.waitForTimeout(700); // debounced sidebar auto-save
  await closeAnyModal(page);
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(400);
  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe(priorityBefore);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe(priorityAfter);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // --- Part 2: chain two actions (edit, then delete) and unwind/reapply both ---
  // (Deliberately not adding another bare Ctrl+Z here to "reset" Part 1's
  // state first — undo is a single global stack, and racing another undo
  // against Part 2's own upcoming actions/debounced autosave is exactly the
  // kind of interference this test is trying to rule out. Part 1's edit is
  // restored explicitly at the very end instead, as its own plain action.)
  const chainTitle = `E2E Undo Chain ${Date.now()}`;
  await openAddTask(page);
  await page.getByPlaceholder('Task name').fill(chainTitle);
  await page.getByRole('dialog').getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(400);

  // This task has no due date, and the Tasks page's default List filter is
  // "active" (see TaskListPanel's DEFAULT_FILTER_BY_VIEW), which — unlike
  // "all" — excludes undated tasks entirely from the grouped list. Search
  // bypasses the active/all/noDueDate filter (TaskListPanel's own comment),
  // so filtering by its title is a reliable way to find/open it regardless
  // of which filter happens to be selected.
  const chainSearch = page.getByPlaceholder(/search tasks/i);
  async function openChainTask() {
    await chainSearch.fill(chainTitle);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); // close SearchBar's own suggestion dropdown
    await page.waitForTimeout(200);
    // Scoped to the actual list row (not getByText, which also matches
    // SearchBar's own live-suggestion dropdown item sharing this title).
    await page.locator('.task-row', { hasText: chainTitle }).click();
    await page.waitForTimeout(300);
  }

  await openChainTask();
  await chooseSelectMenuOption(page, 'Priority', 'Urgent');
  await page.waitForTimeout(700);
  await closeAnyModal(page);
  await page.waitForTimeout(300);

  // Action 2: delete it.
  await openChainTask();
  await page.getByRole('button', { name: /more actions/i }).click();
  await page.getByRole('menuitem', { name: /delete/i }).click();
  await page.waitForTimeout(400);
  const chainRow = page.locator('.task-row', { hasText: chainTitle });
  await expect(chainRow).not.toBeVisible();

  // Undo #1 unwinds the delete (task reappears, still urgent).
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(400);
  await expect(chainRow).toBeVisible();
  await openChainTask();
  await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('Urgent');
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // Undo #2 unwinds the priority edit (back to whatever the default was).
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(400);
  await openChainTask();
  await expect.poll(() => selectMenuLabel(page, 'Priority')).not.toBe('Urgent');
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // Redo #1 reapplies the priority edit.
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  await openChainTask();
  await expect.poll(() => selectMenuLabel(page, 'Priority')).toBe('Urgent');
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  // Redo #2 reapplies the delete.
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  await expect(chainRow).not.toBeVisible();

  // Restore Part 1's priority edit as a plain action (not another undo — see
  // the comment above) so this test doesn't leave "Refactor auth module"
  // permanently changed for other specs sharing this app instance. Clear the
  // chain-task search filter first so "Refactor auth module" is findable again.
  await chainSearch.fill('');
  await page.waitForTimeout(300);
  await page.getByText('Refactor auth module', { exact: false }).first().click();
  await page.waitForTimeout(300);
  await chooseSelectMenuOption(page, 'Priority', priorityBefore);
  await page.waitForTimeout(700);
  await closeAnyModal(page);
  await page.waitForTimeout(200);

  expectNoErrors(errors);
});

test('mention autocomplete: typing "#" in the task title suggests and inserts a project', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await gotoTab(page, 'Tasks');
  // Not using helpers.openAddTask here: with AI Quick Add configured (true in
  // this local .env), AddTaskFabGroup's "Add task" button first expands into
  // a two-button speed dial (see AddTaskFabGroup.jsx) rather than opening the
  // modal directly — the shared helper assumes the plain single-button FAB.
  await page.getByRole('button', { name: /^add task$/i }).click();
  await page.waitForTimeout(200);
  const titleField = page.getByPlaceholder('Task name');
  if (!(await titleField.isVisible({ timeout: 800 }).catch(() => false))) {
    await page.getByRole('button', { name: /^add task$/i }).click();
  }
  await expect(titleField).toBeVisible();
  await titleField.pressSequentially('Ship the release #Wor');
  await page.waitForTimeout(300);

  const dropdown = page.locator('.mention-dropdown');
  await expect(dropdown).toBeVisible();
  const workOption = dropdown.getByRole('option', { name: 'Work' });
  await expect(workOption).toBeVisible();
  await workOption.click();
  await page.waitForTimeout(200);

  await expect(dropdown).not.toBeVisible();
  await expect(titleField).toHaveValue(/#Work/);

  await closeAnyModal(page);
  expectNoErrors(errors);
});

test('command palette: "Add note" opens the note editor even when the Dashboard is not the active tab', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  // Deliberately started from Calendar: the palette action opens the editor
  // at App level rather than signalling the Dashboard's Notes widget, which
  // can be switched off entirely.
  await gotoTab(page, 'Calendar');

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.getByLabel('Command palette search').fill('Add note');
  await palette.getByRole('option', { name: 'Add note' }).first().click();

  await expect(page.locator('.modal-note-editor')).toBeVisible();
  await page.getByPlaceholder('Title').fill('Noted from the palette');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.modal-note-editor')).toHaveCount(0);

  await gotoTab(page, 'Dashboard');
  await expect(page.locator('.note-tile-title', { hasText: 'Noted from the palette' })).toBeVisible();

  expectNoErrors(errors);
});
