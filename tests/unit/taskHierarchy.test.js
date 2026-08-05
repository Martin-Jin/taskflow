import { describe, it, expect } from 'vitest';
import {
  isCompletedForCurrentOccurrence,
  areAllChildrenCompletedForCurrentOccurrence,
} from '../../src/utils/taskHierarchy';

const TODAY = '2026-08-06';

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
