import { describe, it, expect } from 'vitest';
import { isCompletedOnDay, groupItemsByDay } from '../../src/utils/calendarGrouping';

describe('isCompletedOnDay', () => {
  it('always shows a task that is not completed', () => {
    const task = { isCompleted: false };
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true);
  });

  it('always shows a recurring task regardless of completion state', () => {
    const task = { isRecurring: true, isCompleted: true, completedAt: '2026-08-01T10:00:00.000Z' };
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true);
  });

  // completedAt is built from a local Date (matches how completeTask stamps
  // it — `new Date().toISOString()` — and how the rest of the app reads it
  // back via local Date methods), not a hand-written UTC string, so these
  // assertions hold regardless of which timezone the test runner is in.
  function completedAtOn(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d, 15, 30, 0).toISOString();
  }

  it('shows a completed one-off task on its completion date', () => {
    const task = { isCompleted: true, completedAt: completedAtOn('2026-08-07') };
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true);
  });

  it('keeps showing a completed one-off task on its original scheduled day after completion, as history', () => {
    const task = { isCompleted: true, completedAt: completedAtOn('2026-08-07') };
    expect(isCompletedOnDay(task, '2026-08-03')).toBe(true); // scheduled/completed before "today"
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true); // the completion day itself
  });

  it('hides a task completed in advance of its scheduled day (future block disappears)', () => {
    // Scheduled for a future day, but marked done today — the future block
    // never actually happened, so it should not render.
    const task = { isCompleted: true, completedAt: completedAtOn('2026-08-07') };
    expect(isCompletedOnDay(task, '2026-08-10')).toBe(false); // its future scheduled day
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true); // today, the actual completion date
  });

  it('treats a completed task with no completedAt as visible everywhere (defensive default)', () => {
    const task = { isCompleted: true, completedAt: null };
    expect(isCompletedOnDay(task, '2026-08-07')).toBe(true);
  });

  it('treats a missing task as visible (matches existing dangling-taskId tolerance elsewhere)', () => {
    expect(isCompletedOnDay(null, '2026-08-07')).toBe(true);
    expect(isCompletedOnDay(undefined, '2026-08-07')).toBe(true);
  });
});

describe('groupItemsByDay completed-task filtering', () => {
  const days = ['2026-08-06', '2026-08-07', '2026-08-08'];

  it('leaves blocks unfiltered when taskById is not passed (back-compat)', () => {
    const blocks = [{ id: 'b1', date: '2026-08-06', taskId: 't1' }];
    const { blocksByDay } = groupItemsByDay(blocks, [], days);
    expect(blocksByDay.get('2026-08-06')).toHaveLength(1);
  });

  it('keeps a completed one-off task block on its originally-scheduled (past) day', () => {
    const taskById = { t1: { id: 't1', isCompleted: true, completedAt: new Date(2026, 7, 7, 12, 0, 0).toISOString() } };
    const blocks = [{ id: 'b1', date: '2026-08-06', taskId: 't1' }];
    const { blocksByDay } = groupItemsByDay(blocks, [], days, taskById);
    expect(blocksByDay.get('2026-08-06')).toHaveLength(1);
  });

  it('drops a block on a future day for a task completed early', () => {
    const taskById = { t1: { id: 't1', isCompleted: true, completedAt: new Date(2026, 7, 6, 12, 0, 0).toISOString() } };
    const blocks = [{ id: 'b1', date: '2026-08-08', taskId: 't1' }];
    const { blocksByDay } = groupItemsByDay(blocks, [], days, taskById);
    expect(blocksByDay.has('2026-08-08')).toBe(false);
  });

  it('keeps a block whose task is incomplete', () => {
    const taskById = { t1: { id: 't1', isCompleted: false } };
    const blocks = [{ id: 'b1', date: '2026-08-06', taskId: 't1' }];
    const { blocksByDay } = groupItemsByDay(blocks, [], days, taskById);
    expect(blocksByDay.get('2026-08-06')).toHaveLength(1);
  });
});
