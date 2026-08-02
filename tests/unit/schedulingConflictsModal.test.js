/**
 * ============================================================================
 * SchedulingConflictsModal grouping/sort — coverage notes
 * ============================================================================
 * Covers `conflictDayKey`/`buildConflictItems`, the pure helpers extracted
 * from SchedulingConflictsModal.jsx (src/components/Modals/
 * SchedulingConflictsModal.jsx) specifically so this logic could be unit
 * tested — same "extract the pure decision" pattern useCloudSync.js's
 * computeFingerprint/planRemoteDataMerge use.
 *
 * These fix a duplicate/incorrectly-grouped-conflicts bug: a conflict entry
 * used to key/sort by its TASK's `dueDate`, so two different overflow
 * entries for the same task (e.g. a recurring task missed on two separate
 * occurrences) collapsed into one "day" group instead of their own two —
 * allocator.js now stamps each overflow entry with its OWN `dueDate` (the day
 * the allocator was actually trying to place it into), and these helpers key
 * off that first, falling back to the task's `dueDate` only for older
 * overflow entries that predate the field.
 * ============================================================================
 */

import { describe, it, expect } from 'vitest';
import { conflictDayKey, buildConflictItems } from '../../src/components/Modals/SchedulingConflictsModal.jsx';

describe('conflictDayKey', () => {
  it("prefers the conflict entry's own dueDate over the task's", () => {
    const item = { dueDate: '2026-08-05', task: { dueDate: '2026-08-01' } };
    expect(conflictDayKey(item)).toBe('2026-08-05');
  });

  it("falls back to the task's dueDate when the entry has none (older overflow entries)", () => {
    const item = { dueDate: undefined, task: { dueDate: '2026-08-01' } };
    expect(conflictDayKey(item)).toBe('2026-08-01');
  });

  it('returns null when neither the entry nor the task has a due date', () => {
    expect(conflictDayKey({ task: {} })).toBe(null);
    expect(conflictDayKey({ task: null })).toBe(null);
  });
});

describe('buildConflictItems', () => {
  const tasks = [
    { id: 't1', title: 'Recurring task', dueDate: '2026-08-01' },
    { id: 't2', title: 'One-off task', dueDate: '2026-08-03' },
  ];

  it('attaches each conflict its resolved task', () => {
    const items = buildConflictItems([{ taskId: 't1', dueDate: '2026-08-01' }], tasks);
    expect(items).toHaveLength(1);
    expect(items[0].task).toBe(tasks[0]);
  });

  it('drops conflicts whose task no longer exists', () => {
    const items = buildConflictItems([{ taskId: 'missing', dueDate: '2026-08-01' }], tasks);
    expect(items).toHaveLength(0);
  });

  it('sorts by each entry\'s OWN dueDate, not the task\'s — two occurrences of the same recurring task stay in separate day groups instead of collapsing into one', () => {
    const conflicts = [
      { taskId: 't1', dueDate: '2026-08-10' }, // t1's second missed occurrence
      { taskId: 't1', dueDate: '2026-08-01' }, // t1's first missed occurrence
      { taskId: 't2', dueDate: '2026-08-03' },
    ];
    const items = buildConflictItems(conflicts, tasks);
    expect(items.map((i) => i.dueDate)).toEqual(['2026-08-01', '2026-08-03', '2026-08-10']);
  });

  it('sorts undated conflicts last', () => {
    const conflicts = [
      { taskId: 't1', dueDate: undefined },
      { taskId: 't2', dueDate: '2026-08-03' },
    ];
    const tasksNoDue = [
      { id: 't1', title: 'No due date task' },
      { id: 't2', title: 'Dated task', dueDate: '2026-08-03' },
    ];
    const items = buildConflictItems(conflicts, tasksNoDue);
    expect(items.map((i) => i.taskId)).toEqual(['t2', 't1']);
  });
});
