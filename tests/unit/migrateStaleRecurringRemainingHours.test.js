import { describe, it, expect } from 'vitest';
import { migrateStaleRecurringRemainingHours } from '../../src/migrations/migrateStaleRecurringRemainingHours';

describe('migrateStaleRecurringRemainingHours', () => {
  it('resets remainingHours to estimatedHours for a recurring task stuck at 0 with no matching completedDates entry', () => {
    const tasks = [
      { id: 't1', isRecurring: true, dueDate: '2026-08-06', estimatedHours: 0.5, remainingHours: 0, completedDates: [] },
    ];
    const result = migrateStaleRecurringRemainingHours(tasks);
    expect(result.find((t) => t.id === 't1').remainingHours).toBe(0.5);
  });

  it('clears a leftover isCompleted flag on the same repaired task', () => {
    const tasks = [
      {
        id: 't1',
        isRecurring: true,
        dueDate: '2026-08-06',
        estimatedHours: 0.5,
        remainingHours: 0,
        isCompleted: true,
        completedDates: [],
      },
    ];
    const result = migrateStaleRecurringRemainingHours(tasks);
    expect(result.find((t) => t.id === 't1').isCompleted).toBe(false);
  });

  it('leaves a recurring task alone when its current dueDate IS in completedDates (legitimately done for now)', () => {
    const tasks = [
      {
        id: 't1',
        isRecurring: true,
        dueDate: '2026-08-06',
        estimatedHours: 0.5,
        remainingHours: 0,
        completedDates: ['2026-08-06'],
      },
    ];
    expect(migrateStaleRecurringRemainingHours(tasks)).toBe(tasks);
  });

  it('leaves a healthy recurring task (remainingHours > 0) untouched', () => {
    const tasks = [
      { id: 't1', isRecurring: true, dueDate: '2026-08-06', estimatedHours: 1, remainingHours: 1, completedDates: [] },
    ];
    expect(migrateStaleRecurringRemainingHours(tasks)).toBe(tasks);
  });

  it('ignores a non-recurring task with remainingHours 0 (that is legitimately completed)', () => {
    const tasks = [{ id: 't1', isRecurring: false, remainingHours: 0, isCompleted: true }];
    expect(migrateStaleRecurringRemainingHours(tasks)).toBe(tasks);
  });

  it('ignores a recurring task with no dueDate', () => {
    const tasks = [{ id: 't1', isRecurring: true, dueDate: null, remainingHours: 0, estimatedHours: 1 }];
    expect(migrateStaleRecurringRemainingHours(tasks)).toBe(tasks);
  });

  it('only touches the stuck task, leaving unrelated tasks in the same array untouched', () => {
    const tasks = [
      { id: 'stuck', isRecurring: true, dueDate: '2026-08-06', estimatedHours: 0.5, remainingHours: 0, completedDates: [] },
      { id: 'fine', isRecurring: true, dueDate: '2026-08-07', estimatedHours: 1, remainingHours: 1, completedDates: [] },
    ];
    const result = migrateStaleRecurringRemainingHours(tasks);
    expect(result.find((t) => t.id === 'fine')).toEqual(tasks[1]);
    expect(result.find((t) => t.id === 'stuck').remainingHours).toBe(0.5);
  });

  it('is idempotent: running it twice produces the same result as running it once', () => {
    const tasks = [
      { id: 't1', isRecurring: true, dueDate: '2026-08-06', estimatedHours: 0.5, remainingHours: 0, completedDates: [] },
    ];
    const once = migrateStaleRecurringRemainingHours(tasks);
    const twice = migrateStaleRecurringRemainingHours(once);
    expect(twice).toBe(once);
  });

  it('passes through non-array input unchanged (defensive no-op)', () => {
    expect(migrateStaleRecurringRemainingHours(undefined)).toBeUndefined();
    expect(migrateStaleRecurringRemainingHours(null)).toBeNull();
  });

  it('passes through an empty array unchanged', () => {
    expect(migrateStaleRecurringRemainingHours([])).toEqual([]);
  });
});
