import { describe, it, expect } from 'vitest';
import {
  isCompletedForCurrentOccurrence,
  areAllChildrenCompletedForCurrentOccurrence,
  isCheckedForListDisplay,
  applyUpwardCompletionCascade,
} from '../../src/utils/taskHierarchy';
import { planSubtaskOccurrenceCompletion } from '../../src/utils/recurrenceState';
import { deriveRecurrenceRule } from '../../src/utils/recurrence';

const TODAY = '2026-08-06';

/** A daily-recurring task/sub-task, anchored and due today unless overridden. */
function recurringTask(overrides = {}) {
  const recurrenceString = overrides.recurrenceString ?? 'every day';
  return {
    isRecurring: true,
    recurrenceString,
    recurrenceRule: deriveRecurrenceRule(recurrenceString),
    recurrenceAnchor: TODAY,
    completedOccurrences: [],
    skippedThrough: null,
    dueDate: TODAY,
    completedDates: [],
    ...overrides,
  };
}

describe('isCompletedForCurrentOccurrence', () => {
  it('reads isCompleted directly for a non-recurring task', () => {
    expect(isCompletedForCurrentOccurrence({ isCompleted: true }, TODAY)).toBe(true);
    expect(isCompletedForCurrentOccurrence({ isCompleted: false }, TODAY)).toBe(false);
  });

  it('is true for a recurring task whose completedDates includes today', () => {
    const task = { isRecurring: true, isCompleted: false, completedDates: [TODAY, '2026-08-05'] };
    expect(isCompletedForCurrentOccurrence(task, TODAY)).toBe(true);
  });

  it('is false for a recurring task whose completedDates does not include today', () => {
    const task = { isRecurring: true, isCompleted: false, completedDates: ['2026-08-05'] };
    expect(isCompletedForCurrentOccurrence(task, TODAY)).toBe(false);
  });

  it('is false for a recurring task with no completedDates at all', () => {
    const task = { isRecurring: true, isCompleted: false };
    expect(isCompletedForCurrentOccurrence(task, TODAY)).toBe(false);
  });

  it('ignores isCompleted for a recurring task even if it were somehow true', () => {
    // completeTask never actually sets this, but the helper should still key
    // purely off completedDates for a recurring task, not isCompleted.
    const task = { isRecurring: true, isCompleted: true, completedDates: [] };
    expect(isCompletedForCurrentOccurrence(task, TODAY)).toBe(false);
  });
});

describe('isCheckedForListDisplay', () => {
  it('matches isCompletedForCurrentOccurrence for a non-recurring task', () => {
    expect(isCheckedForListDisplay({ isCompleted: true }, TODAY)).toBe(true);
    expect(isCheckedForListDisplay({ isCompleted: false }, TODAY)).toBe(false);
  });

  it('is checked for a recurring task whose occurrence is due today and completed', () => {
    const task = { isRecurring: true, dueDate: TODAY, completedDates: [TODAY] };
    expect(isCheckedForListDisplay(task, TODAY)).toBe(true);
  });

  it('is checked for a recurring task whose occurrence is overdue but was completed today', () => {
    // e.g. a daily task completed late — its dueDate stays at the missed
    // occurrence's date while completedDates records today's completion.
    const task = { isRecurring: true, dueDate: '2026-08-05', completedDates: [TODAY] };
    expect(isCheckedForListDisplay(task, TODAY)).toBe(true);
  });

  it(
    'is NOT checked for a recurring task whose occurrence already rolled forward into the future, ' +
      'even though today is still in its completedDates window',
    () => {
      // Regression: completing today's occurrence advances dueDate to the next
      // occurrence (e.g. tomorrow, for a daily task) while today's date stays
      // in the rolling completedDates window — the task should show up in
      // "Upcoming" in its normal, not-completed state, not struck through.
      const task = { isRecurring: true, dueDate: '2026-08-07', completedDates: [TODAY] };
      expect(isCheckedForListDisplay(task, TODAY)).toBe(false);
    }
  );

  it('is not checked for a recurring task with no dueDate at all', () => {
    const task = { isRecurring: true, completedDates: [TODAY] };
    expect(isCheckedForListDisplay(task, TODAY)).toBe(false);
  });
});

describe('areAllChildrenCompletedForCurrentOccurrence', () => {
  it('is false for a task with no children', () => {
    const tasks = [{ id: 'parent' }];
    expect(areAllChildrenCompletedForCurrentOccurrence('parent', tasks, TODAY)).toBe(false);
  });

  it('is true when every direct child is completed for today', () => {
    const tasks = [
      { id: 'parent' },
      { id: 'c1', parentId: 'parent', isCompleted: true },
      { id: 'c2', parentId: 'parent', isRecurring: true, completedDates: [TODAY] },
    ];
    expect(areAllChildrenCompletedForCurrentOccurrence('parent', tasks, TODAY)).toBe(true);
  });

  it('is false when at least one direct child is not yet completed for today', () => {
    const tasks = [
      { id: 'parent' },
      { id: 'c1', parentId: 'parent', isCompleted: true },
      { id: 'c2', parentId: 'parent', isRecurring: true, completedDates: [] },
    ];
    expect(areAllChildrenCompletedForCurrentOccurrence('parent', tasks, TODAY)).toBe(false);
  });

  it('only looks at direct children, not grandchildren', () => {
    // A completed grandchild under an incomplete child shouldn't matter here
    // — grandchild-rollup only kicks in via completeTask's own upward walk.
    const tasks = [
      { id: 'parent' },
      { id: 'child', parentId: 'parent', isCompleted: false },
      { id: 'grandchild', parentId: 'child', isCompleted: true },
    ];
    expect(areAllChildrenCompletedForCurrentOccurrence('parent', tasks, TODAY)).toBe(false);
  });
});

describe('applyUpwardCompletionCascade', () => {
  it('(a) completing one recurring sub-task alone does not cascade the parent, and does not advance the sub-task itself', () => {
    const parent = recurringTask({ id: 'parent' });
    // c1 is completed for today (simulating completeTask's planSubtaskOccurrenceCompletion
    // branch); c2 is its still-outstanding sibling.
    const c1 = { ...recurringTask({ id: 'c1', parentId: 'parent' }), completedDates: [TODAY] };
    const c2 = recurringTask({ id: 'c2', parentId: 'parent' });
    const tasks = [parent, c1, c2];
    const result = applyUpwardCompletionCascade(tasks, 'c1', TODAY, `${TODAY}T12:00:00.000Z`);
    const resultParent = result.find((t) => t.id === 'parent');
    const resultC1 = result.find((t) => t.id === 'c1');
    // Parent untouched — not every child is done yet.
    expect(resultParent.dueDate).toBe(TODAY);
    expect(resultParent.completedDates ?? []).not.toContain(TODAY);
    // c1 itself is untouched by the cascade (it stays pinned — see completeTask).
    expect(resultC1.dueDate).toBe(TODAY);
  });

  it('(b) completing the last remaining sub-task cascades: parent AND every recurring sibling advance together', () => {
    const parent = recurringTask({ id: 'parent' });
    // Both children already marked done for today (as planSubtaskOccurrenceCompletion
    // would leave them) — completing c2 (the caller's taskId) is what triggers the cascade.
    const c1 = { ...recurringTask({ id: 'c1', parentId: 'parent' }), completedDates: [TODAY] };
    const c2 = { ...recurringTask({ id: 'c2', parentId: 'parent' }), completedDates: [TODAY] };
    const tasks = [parent, c1, c2];
    const result = applyUpwardCompletionCascade(tasks, 'c2', TODAY, `${TODAY}T12:00:00.000Z`);
    const resultParent = result.find((t) => t.id === 'parent');
    const resultC1 = result.find((t) => t.id === 'c1');
    const resultC2 = result.find((t) => t.id === 'c2');
    const nextDay = '2026-08-07';
    expect(resultParent.dueDate).toBe(nextDay);
    expect(resultC1.dueDate).toBe(nextDay);
    expect(resultC2.dueDate).toBe(nextDay);
  });

  it('(c) a non-recurring parent still auto-completes once every child is done, regardless of recurrence', () => {
    const tasks = [
      { id: 'parent' },
      { id: 'c1', isCompleted: true },
      { id: 'c2', isCompleted: false },
    ].map((t, i) => (i === 0 ? t : { ...t, parentId: 'parent' }));
    // c2 just got completed directly.
    tasks[2].isCompleted = true;
    const result = applyUpwardCompletionCascade(tasks, 'c2', TODAY, `${TODAY}T12:00:00.000Z`);
    expect(result.find((t) => t.id === 'parent').isCompleted).toBe(true);
  });

  it('stops walking once a parent is already completed for the current occurrence (no double-advance)', () => {
    const parent = { ...recurringTask({ id: 'parent' }), completedDates: [TODAY] };
    const c1 = { ...recurringTask({ id: 'c1', parentId: 'parent' }), completedDates: [TODAY] };
    const result = applyUpwardCompletionCascade([parent, c1], 'c1', TODAY, `${TODAY}T12:00:00.000Z`);
    // Already-done parent is left exactly as-is — not re-advanced a second time.
    expect(result.find((t) => t.id === 'parent').dueDate).toBe(TODAY);
  });

  it('rolls a grandchild forward together with a recurring parent two levels up', () => {
    const grandparent = recurringTask({ id: 'gp' });
    const parent = { ...recurringTask({ id: 'p', parentId: 'gp' }), completedDates: [TODAY] };
    const child = { ...recurringTask({ id: 'c', parentId: 'p' }), completedDates: [TODAY] };
    const tasks = [grandparent, parent, child];
    const result = applyUpwardCompletionCascade(tasks, 'p', TODAY, `${TODAY}T12:00:00.000Z`);
    const nextDay = '2026-08-07';
    expect(result.find((t) => t.id === 'gp').dueDate).toBe(nextDay);
    expect(result.find((t) => t.id === 'c').dueDate).toBe(nextDay);
  });

  it('integrates with planSubtaskOccurrenceCompletion end-to-end: pinned sub-tasks only advance once the group closes out', () => {
    const parent = recurringTask({ id: 'parent' });
    const c1 = recurringTask({ id: 'c1', parentId: 'parent' });
    const c2 = recurringTask({ id: 'c2', parentId: 'parent' });

    // Step 1: complete c1 alone via the real sub-task completion helper.
    const afterC1 = { ...c1, ...planSubtaskOccurrenceCompletion(c1, TODAY, TODAY) };
    expect(afterC1.dueDate).toBe(TODAY); // pinned
    let tasks = [parent, afterC1, c2];
    tasks = applyUpwardCompletionCascade(tasks, 'c1', TODAY, `${TODAY}T12:00:00.000Z`);
    // Nothing cascaded yet — c2 isn't done.
    expect(tasks.find((t) => t.id === 'parent').dueDate).toBe(TODAY);
    expect(tasks.find((t) => t.id === 'c1').dueDate).toBe(TODAY);

    // Step 2: complete c2, the last remaining sub-task — this closes the group out.
    const c2Before = tasks.find((t) => t.id === 'c2');
    const afterC2 = { ...c2Before, ...planSubtaskOccurrenceCompletion(c2Before, TODAY, TODAY) };
    tasks = tasks.map((t) => (t.id === 'c2' ? afterC2 : t));
    tasks = applyUpwardCompletionCascade(tasks, 'c2', TODAY, `${TODAY}T12:00:00.000Z`);

    const nextDay = '2026-08-07';
    expect(tasks.find((t) => t.id === 'parent').dueDate).toBe(nextDay);
    expect(tasks.find((t) => t.id === 'c1').dueDate).toBe(nextDay);
    expect(tasks.find((t) => t.id === 'c2').dueDate).toBe(nextDay);
  });
});
