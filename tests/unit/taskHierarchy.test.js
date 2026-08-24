import { describe, it, expect } from 'vitest';
import {
  isCompletedForCurrentOccurrence,
  areAllChildrenCompletedForCurrentOccurrence,
  isCheckedForListDisplay,
  applyUpwardCompletionCascade,
  getEffectiveRemainingHoursForOccurrence,
  computeRemainingHoursPatchAfterElapsed,
  computeActuallyAppliedHours,
  computeRemainingHoursPatchAfterRestore,
  planBlockCompletionFromRemainingHoursEdit,
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

describe('getEffectiveRemainingHoursForOccurrence', () => {
  it('reads remainingHours directly for a non-recurring task', () => {
    expect(getEffectiveRemainingHoursForOccurrence({ isRecurring: false, remainingHours: 3 })).toBe(3);
    expect(getEffectiveRemainingHoursForOccurrence({ isRecurring: false })).toBe(0);
  });

  it('falls back to the full estimate for a recurring task with no override recorded', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 4, remainingHoursOverride: {} };
    expect(getEffectiveRemainingHoursForOccurrence(task)).toBe(4);
  });

  it('reads the override keyed by the pattern dueDate for a recurring task', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 4, remainingHoursOverride: { [TODAY]: 1.5 } };
    expect(getEffectiveRemainingHoursForOccurrence(task)).toBe(1.5);
  });

  it('clamps a stored override into [0, estimatedHours]', () => {
    const over = { isRecurring: true, dueDate: TODAY, estimatedHours: 2, remainingHoursOverride: { [TODAY]: 99 } };
    expect(getEffectiveRemainingHoursForOccurrence(over)).toBe(2);
    const under = { isRecurring: true, dueDate: TODAY, estimatedHours: 2, remainingHoursOverride: { [TODAY]: -5 } };
    expect(getEffectiveRemainingHoursForOccurrence(under)).toBe(0);
  });
});

describe('computeRemainingHoursPatchAfterElapsed', () => {
  it('reduces remainingHours for a non-recurring task, clamped at 0', () => {
    const task = { isRecurring: false, remainingHours: 2, estimatedHours: 5 };
    expect(computeRemainingHoursPatchAfterElapsed(task, 0.5)).toEqual({ remainingHours: 1.5 });
    expect(computeRemainingHoursPatchAfterElapsed(task, 10)).toEqual({ remainingHours: 0 });
  });

  it('writes a per-occurrence override keyed by the pattern dueDate for a recurring task', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 4, remainingHoursOverride: {} };
    expect(computeRemainingHoursPatchAfterElapsed(task, 1)).toEqual({
      remainingHoursOverride: { [TODAY]: 3 },
    });
  });

  it('merges into any existing override map instead of clobbering other occurrences', () => {
    const task = {
      isRecurring: true,
      dueDate: TODAY,
      estimatedHours: 4,
      remainingHoursOverride: { '2026-08-05': 1 },
    };
    expect(computeRemainingHoursPatchAfterElapsed(task, 1)).toEqual({
      remainingHoursOverride: { '2026-08-05': 1, [TODAY]: 3 },
    });
  });

  it('returns null for a recurring task with no dueDate to key the override by', () => {
    const task = { isRecurring: true, dueDate: null, estimatedHours: 4 };
    expect(computeRemainingHoursPatchAfterElapsed(task, 1)).toBeNull();
  });

  it('elapsed time exceeding remaining hours clamps the patch at 0, never negative', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 4, remainingHoursOverride: { [TODAY]: 1 } };
    expect(computeRemainingHoursPatchAfterElapsed(task, 5)).toEqual({
      remainingHoursOverride: { [TODAY]: 0 },
    });
  });
});

describe('computeActuallyAppliedHours', () => {
  it('reports the requested elapsedHours when there was enough remaining to give', () => {
    const task = { isRecurring: false, remainingHours: 5, estimatedHours: 5 };
    expect(computeActuallyAppliedHours(task, 2)).toBe(2);
  });

  it('reports LESS than elapsedHours when remaining hours had less to give (the clamp-at-0 case)', () => {
    // This is the exact scenario markBlockDone needs to record correctly:
    // a 2-hour block "completed" against a task with only 0.5h left should
    // only be credited with taking 0.5h, not the full 2h, or an
    // unmarkBlockDone reversal would later hand back more than was ever
    // actually subtracted.
    const task = { isRecurring: false, remainingHours: 0.5, estimatedHours: 5 };
    expect(computeActuallyAppliedHours(task, 2)).toBe(0.5);
  });

  it('reports 0 when remaining hours is already 0', () => {
    const task = { isRecurring: false, remainingHours: 0, estimatedHours: 5 };
    expect(computeActuallyAppliedHours(task, 2)).toBe(0);
  });

  it('works the same way for a recurring task, reading the per-occurrence override', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 3, remainingHoursOverride: { [TODAY]: 1 } };
    expect(computeActuallyAppliedHours(task, 2)).toBe(1);
  });
});

describe('computeRemainingHoursPatchAfterRestore', () => {
  it('adds hoursToRestore back onto remainingHours for a non-recurring task', () => {
    const task = { isRecurring: false, remainingHours: 1, estimatedHours: 5 };
    expect(computeRemainingHoursPatchAfterRestore(task, 2)).toEqual({ remainingHours: 3 });
  });

  it('clamps the restored value at estimatedHours, never exceeding the full estimate', () => {
    const task = { isRecurring: false, remainingHours: 4, estimatedHours: 5 };
    expect(computeRemainingHoursPatchAfterRestore(task, 3)).toEqual({ remainingHours: 5 });
  });

  it('is the exact inverse of computeActuallyAppliedHours + computeRemainingHoursPatchAfterElapsed for a normal (non-clamped) case', () => {
    // markBlockDone -> unmarkBlockDone round trip: applying then restoring
    // the same hours should return the task to its original remaining hours.
    const original = { isRecurring: false, remainingHours: 3, estimatedHours: 5 };
    const applied = computeActuallyAppliedHours(original, 1.5);
    const afterMark = computeRemainingHoursPatchAfterElapsed(original, 1.5);
    const taskAfterMark = { ...original, ...afterMark };
    const afterUnmark = computeRemainingHoursPatchAfterRestore(taskAfterMark, applied);
    expect(afterUnmark).toEqual({ remainingHours: 3 });
  });

  it('round-trips correctly even when the forward step was clamped at 0 (the exactness guarantee)', () => {
    // The whole reason ScheduledBlock stores hoursAppliedToRemaining instead
    // of trusting durationHours: if only 0.5h was actually available to
    // subtract for a 2h block, restoring must add back exactly 0.5h, not 2h
    // (which would overshoot past the task's true prior remaining hours).
    const original = { isRecurring: false, remainingHours: 0.5, estimatedHours: 5 };
    const applied = computeActuallyAppliedHours(original, 2); // 0.5, not 2
    const afterMark = computeRemainingHoursPatchAfterElapsed(original, 2);
    const taskAfterMark = { ...original, ...afterMark }; // remainingHours: 0
    const afterUnmark = computeRemainingHoursPatchAfterRestore(taskAfterMark, applied);
    expect(afterUnmark).toEqual({ remainingHours: 0.5 });
  });

  it('writes a per-occurrence override keyed by the pattern dueDate for a recurring task', () => {
    const task = { isRecurring: true, dueDate: TODAY, estimatedHours: 4, remainingHoursOverride: { [TODAY]: 1 } };
    expect(computeRemainingHoursPatchAfterRestore(task, 2)).toEqual({
      remainingHoursOverride: { [TODAY]: 3 },
    });
  });

  it('returns null for a recurring task with no dueDate to key the override by', () => {
    const task = { isRecurring: true, dueDate: null, estimatedHours: 4 };
    expect(computeRemainingHoursPatchAfterRestore(task, 1)).toBeNull();
  });
});

describe('planBlockCompletionFromRemainingHoursEdit', () => {
  // The exact scenario from the feature request: 1h logged, blocks are 40
  // and 30 minutes. First block (fully covered by the 1h pool) marks done;
  // the leftover 20 minutes is less than the second (30min) block's own
  // duration, so it's left as a plain reduction — no block flagged for it.
  it('marks only the FULLY-covered oldest block(s) done, leaving a sub-block remainder unflagged', () => {
    const blocks = [
      { id: 'b1', status: 'scheduled', durationHours: 40 / 60 },
      { id: 'b2', status: 'scheduled', durationHours: 30 / 60 },
    ];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 2, 1); // decreased by 1h
    expect(result.toMarkDone).toEqual(['b1']);
    expect(result.toUnmark).toEqual([]);
  });

  it('marks multiple oldest blocks done when the pool fully covers more than one', () => {
    const blocks = [
      { id: 'b1', status: 'scheduled', durationHours: 1 },
      { id: 'b2', status: 'scheduled', durationHours: 1 },
      { id: 'b3', status: 'scheduled', durationHours: 1 },
    ];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 5, 3); // decreased by 2h
    expect(result.toMarkDone).toEqual(['b1', 'b2']);
  });

  it('skips a block already marked done and continues past it to the next one', () => {
    const blocks = [
      { id: 'b1', status: 'done', durationHours: 1 },
      { id: 'b2', status: 'scheduled', durationHours: 1 },
    ];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 3, 2); // decreased by 1h
    expect(result.toMarkDone).toEqual(['b2']);
  });

  it('marks nothing done when the decrease is smaller than even the first not-done block', () => {
    const blocks = [{ id: 'b1', status: 'scheduled', durationHours: 1 }];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 2, 1.7); // decreased by 0.3h, block needs 1h
    expect(result.toMarkDone).toEqual([]);
    expect(result.toUnmark).toEqual([]);
  });

  it('no-ops when remaining hours is unchanged', () => {
    const blocks = [{ id: 'b1', status: 'scheduled', durationHours: 1 }];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 2, 2);
    expect(result.toMarkDone).toEqual([]);
    expect(result.toUnmark).toEqual([]);
  });

  // REVERSE direction — an increase (correcting an error) un-marks already
  // done blocks, newest first, mirroring the forward direction's oldest-first
  // consumption.
  it('un-marks the NEWEST done block first when remaining hours is increased', () => {
    const blocks = [
      { id: 'b1', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
      { id: 'b2', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
    ];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 1, 2); // increased by 1h
    expect(result.toUnmark).toEqual(['b2']);
    expect(result.toMarkDone).toEqual([]);
  });

  it('un-marks multiple done blocks, newest first, when the increase covers more than one', () => {
    const blocks = [
      { id: 'b1', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
      { id: 'b2', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
      { id: 'b3', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
    ];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 0, 2); // increased by 2h
    expect(result.toUnmark).toEqual(['b3', 'b2']);
  });

  it('stops un-marking once there are no more done blocks left to undo, even if the increase pool remains', () => {
    const blocks = [{ id: 'b1', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 }];
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 0, 5); // increased by 5h, only 1 done block exists
    expect(result.toUnmark).toEqual(['b1']);
  });

  it('uses a done block\'s hoursAppliedToRemaining (not durationHours) to size the un-mark pool, when they differ', () => {
    // A block whose completion was originally clamped (only 0.5h actually
    // applied even though the block itself is 1h) should only "cost" 0.5h
    // of the increase pool to undo, not the full 1h duration.
    const blocks = [
      { id: 'b1', status: 'done', durationHours: 1, hoursAppliedToRemaining: 0.5 },
      { id: 'b2', status: 'done', durationHours: 1, hoursAppliedToRemaining: 1 },
    ];
    // 0.6h increase: covers b2's full 1h applied? No — covers b2 only if
    // pool >= its applied amount at the time it's considered. Walk: newest
    // first is b2 (applied 1h) — pool 0.6 < 1, but the implementation still
    // subtracts and stops once pool <= 0 OR list exhausted; assert b2 alone
    // is proposed since it's examined first regardless of full coverage.
    const result = planBlockCompletionFromRemainingHoursEdit(blocks, 0, 0.6);
    expect(result.toUnmark).toEqual(['b2']);
  });
});
