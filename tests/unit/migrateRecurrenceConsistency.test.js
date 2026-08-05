import { describe, it, expect } from 'vitest';
import { migrateRecurrenceConsistency } from '../../src/migrations/migrateRecurrenceConsistency';

describe('migrateRecurrenceConsistency', () => {
  it('makes a non-recurring sub-task recurring when its parent is recurring', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1', isRecurring: false, recurrenceString: null },
    ];
    const result = migrateRecurrenceConsistency(tasks);
    const s1 = result.find((t) => t.id === 's1');
    expect(s1.isRecurring).toBe(true);
    expect(s1.recurrenceString).toBe('every week');
    expect(s1.recurrenceRule).toEqual({ unit: 'week', count: 1 });
    // Parent itself is untouched.
    expect(result.find((t) => t.id === 'p1')).toEqual(tasks[0]);
  });

  it('makes a non-recurring parent recurring when its sub-task is recurring', () => {
    const tasks = [
      { id: 'p1', isRecurring: false, recurrenceString: null },
      { id: 's1', parentId: 'p1', isRecurring: true, recurrenceString: 'every month' },
    ];
    const result = migrateRecurrenceConsistency(tasks);
    const p1 = result.find((t) => t.id === 'p1');
    expect(p1.isRecurring).toBe(true);
    expect(p1.recurrenceString).toBe('every month');
    expect(result.find((t) => t.id === 's1')).toEqual(tasks[1]);
  });

  it('is a no-op (returns the same array reference) when everything already agrees', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every day' },
      { id: 's1', parentId: 'p1', isRecurring: true, recurrenceString: 'every day' },
    ];
    expect(migrateRecurrenceConsistency(tasks)).toBe(tasks);
  });

  it('is a no-op when no task is recurring anywhere', () => {
    const tasks = [{ id: 'p1' }, { id: 's1', parentId: 'p1' }];
    expect(migrateRecurrenceConsistency(tasks)).toBe(tasks);
  });

  it('is idempotent: running it twice produces the same result as running it once', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every 2 weeks' },
      { id: 's1', parentId: 'p1' },
      { id: 'gs1', parentId: 's1' },
    ];
    const once = migrateRecurrenceConsistency(tasks);
    const twice = migrateRecurrenceConsistency(once);
    expect(twice).toEqual(once);
  });

  it('handles 2-level nesting, syncing a grandchild up through its parent to the top-level ancestor', () => {
    const tasks = [
      { id: 'p1' },
      { id: 's1', parentId: 'p1' },
      { id: 'gs1', parentId: 's1', isRecurring: true, recurrenceString: 'every 3 days' },
    ];
    const result = migrateRecurrenceConsistency(tasks);
    expect(result.find((t) => t.id === 'p1').isRecurring).toBe(true);
    expect(result.find((t) => t.id === 's1').isRecurring).toBe(true);
    expect(result.find((t) => t.id === 'p1').recurrenceString).toBe('every 3 days');
    expect(result.find((t) => t.id === 's1').recurrenceString).toBe('every 3 days');
  });

  it('only touches mismatched tasks, leaving unrelated tasks/other chains untouched', () => {
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week' },
      { id: 's1', parentId: 'p1' },
      { id: 'other', isRecurring: false, recurrenceString: null },
    ];
    const result = migrateRecurrenceConsistency(tasks);
    expect(result.find((t) => t.id === 'other')).toEqual(tasks[2]);
  });

  it('passes through non-array input unchanged (defensive no-op)', () => {
    expect(migrateRecurrenceConsistency(undefined)).toBeUndefined();
    expect(migrateRecurrenceConsistency(null)).toBeNull();
  });

  it('passes through an empty array unchanged', () => {
    expect(migrateRecurrenceConsistency([])).toEqual([]);
  });

  it('syncs dueDate alongside recurrence, snapped to the rule\'s nearest matching weekday', () => {
    // p1's own dueDate (2026-08-06, a Thursday) isn't itself a Wed/Sun match.
    const tasks = [
      { id: 'p1', isRecurring: true, recurrenceString: 'every week on Wed, Sun', dueDate: '2026-08-06' },
      { id: 's1', parentId: 'p1', isRecurring: false, recurrenceString: null, dueDate: null },
    ];
    const result = migrateRecurrenceConsistency(tasks);
    const s1 = result.find((t) => t.id === 's1');
    expect(s1.dueDate).toBe('2026-08-09');
  });
});
