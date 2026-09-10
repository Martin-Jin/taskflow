import { describe, it, expect } from 'vitest';
import { getOverdueTasks } from '../../src/utils/overdueTasks';

// Fixed "now" so date comparisons in these tests are stable regardless of
// when they're actually run.
const NOW = new Date('2026-09-11T12:00:00');

describe('getOverdueTasks', () => {
  it('includes a plain (non-recurring) task whose dueDate has passed', () => {
    const tasks = [
      { id: 't1', title: 'Old task', dueDate: '2026-09-01', isCompleted: false },
    ];
    expect(getOverdueTasks(tasks, NOW).map((t) => t.id)).toEqual(['t1']);
  });

  it('excludes a completed task even if its dueDate has passed', () => {
    const tasks = [
      { id: 't1', title: 'Done task', dueDate: '2026-09-01', isCompleted: true },
    ];
    expect(getOverdueTasks(tasks, NOW)).toEqual([]);
  });

  it('excludes a task due today or in the future', () => {
    const tasks = [
      { id: 't1', title: 'Due today', dueDate: '2026-09-11', isCompleted: false },
      { id: 't2', title: 'Due later', dueDate: '2026-09-20', isCompleted: false },
    ];
    expect(getOverdueTasks(tasks, NOW)).toEqual([]);
  });

  it('still flags a genuinely overdue recurring task with no favorable override', () => {
    const tasks = [
      {
        id: 't1',
        title: 'Recurring, still overdue',
        isRecurring: true,
        dueDate: '2026-09-01',
        overrides: {},
        isCompleted: false,
      },
    ];
    expect(getOverdueTasks(tasks, NOW).map((t) => t.id)).toEqual(['t1']);
  });

  it('excludes a recurring sub-task whose raw dueDate is stale but whose override (cascaded from a parent due-date edit) moves it to today', () => {
    // Mirrors computeRecurringDescendantDueDateOverrides: the raw dueDate is
    // left pointing at the old (past) date, but an overrides entry keyed by
    // that old date redirects the occurrence to the parent's new due date.
    const tasks = [
      {
        id: 'sub1',
        title: 'Recurring sub-task',
        isRecurring: true,
        dueDate: '2026-09-01',
        overrides: { '2026-09-01': { date: '2026-09-11' } },
        isCompleted: false,
      },
    ];
    expect(getOverdueTasks(tasks, NOW)).toEqual([]);
  });

  it('excludes a recurring sub-task whose override moves it into the future', () => {
    const tasks = [
      {
        id: 'sub1',
        title: 'Recurring sub-task',
        isRecurring: true,
        dueDate: '2026-09-01',
        overrides: { '2026-09-01': { date: '2026-09-20' } },
        isCompleted: false,
      },
    ];
    expect(getOverdueTasks(tasks, NOW)).toEqual([]);
  });

  it('still flags a recurring task whose override moves it to an earlier (still past) date', () => {
    const tasks = [
      {
        id: 'sub1',
        title: 'Recurring sub-task',
        isRecurring: true,
        dueDate: '2026-09-05',
        overrides: { '2026-09-05': { date: '2026-09-02' } },
        isCompleted: false,
      },
    ];
    expect(getOverdueTasks(tasks, NOW).map((t) => t.id)).toEqual(['sub1']);
  });

  it('sorts multiple overdue tasks with the oldest (resolved) due date first', () => {
    const tasks = [
      { id: 'a', title: 'A', dueDate: '2026-09-05', isCompleted: false },
      { id: 'b', title: 'B', dueDate: '2026-09-01', isCompleted: false },
    ];
    expect(getOverdueTasks(tasks, NOW).map((t) => t.id)).toEqual(['b', 'a']);
  });
});
