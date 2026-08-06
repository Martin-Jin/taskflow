import { describe, it, expect } from 'vitest';
import { migrateRecurrenceState } from '../../src/migrations/migrateRecurrenceState';
import { deriveRecurringFields } from '../../src/utils/recurrenceState';
import { deriveRecurrenceRule } from '../../src/utils/recurrence';

function recurringTask(overrides = {}) {
  const recurrenceString = overrides.recurrenceString ?? 'every day';
  return {
    id: 't1',
    title: 'Water the plants',
    isRecurring: true,
    recurrenceString,
    recurrenceRule: deriveRecurrenceRule(recurrenceString),
    dueDate: '2026-08-06',
    completedDates: ['2026-08-05', '2026-08-04'],
    completionHistory: { '2026-06': 20, '2026-07': 30 },
    ...overrides,
  };
}

describe('migrateRecurrenceState', () => {
  it('seeds the anchor from the current due date', () => {
    const [migrated] = migrateRecurrenceState([recurringTask()]);
    expect(migrated.recurrenceAnchor).toBe('2026-08-06');
  });

  it('seeds completedOccurrences from completedDates, normalized', () => {
    const [migrated] = migrateRecurrenceState([
      recurringTask({ completedDates: ['2026-08-05', '2026-08-04', '2026-08-05'] }),
    ]);
    expect(migrated.completedOccurrences).toEqual(['2026-08-04', '2026-08-05']);
  });

  it('freezes existing completionHistory as the archive baseline', () => {
    const [migrated] = migrateRecurrenceState([recurringTask()]);
    expect(migrated.completionHistoryArchive).toEqual({ '2026-06': 20, '2026-07': 30 });
  });

  it('leaves the derived fields themselves untouched, so old clients still read them', () => {
    const before = recurringTask();
    const [migrated] = migrateRecurrenceState([before]);
    expect(migrated.dueDate).toBe(before.dueDate);
    expect(migrated.completedDates).toEqual(before.completedDates);
    expect(migrated.completionHistory).toEqual(before.completionHistory);
  });

  describe('the guarantee: deriving after migration reproduces the stored values exactly', () => {
    it('holds for a normal recurring task', () => {
      const before = recurringTask();
      const [migrated] = migrateRecurrenceState([before]);
      const derived = deriveRecurringFields(migrated, '2026-08-06');
      expect(derived.dueDate).toBe(before.dueDate);
      expect(derived.completedDates).toEqual(before.completedDates);
      expect(derived.completionHistory).toEqual(before.completionHistory);
    });

    it('holds for a weekday-specific rule', () => {
      // 2026-08-05 is a Wednesday.
      const before = recurringTask({
        recurrenceString: 'every week on Mon, Wed',
        dueDate: '2026-08-05',
        completedDates: ['2026-08-03'],
        completionHistory: {},
      });
      const [migrated] = migrateRecurrenceState([before]);
      const derived = deriveRecurringFields(migrated, '2026-08-05');
      expect(derived.dueDate).toBe('2026-08-05');
      expect(derived.completedDates).toEqual(['2026-08-03']);
    });

    it('holds for a task that is already overdue', () => {
      const before = recurringTask({ dueDate: '2026-07-01', completedDates: [], completionHistory: {} });
      const [migrated] = migrateRecurrenceState([before]);
      expect(deriveRecurringFields(migrated, '2026-08-06').dueDate).toBe('2026-07-01');
    });

    it('holds for a monthly task', () => {
      const before = recurringTask({
        recurrenceString: 'every month',
        dueDate: '2026-08-31',
        completedDates: [],
        completionHistory: { '2026-05': 1 },
      });
      const [migrated] = migrateRecurrenceState([before]);
      const derived = deriveRecurringFields(migrated, '2026-08-06');
      expect(derived.dueDate).toBe('2026-08-31');
      expect(derived.completionHistory).toEqual({ '2026-05': 1 });
    });

    it('does not lose long-term history that only exists as an aggregate', () => {
      const before = recurringTask({ completedDates: [], completionHistory: { '2025-01': 31 } });
      const [migrated] = migrateRecurrenceState([before]);
      expect(deriveRecurringFields(migrated, '2026-08-06').completionHistory).toEqual({ '2025-01': 31 });
    });
  });

  describe('what it deliberately skips', () => {
    it('leaves non-recurring tasks completely alone', () => {
      const plain = { id: 't2', title: 'One-off', isRecurring: false, dueDate: '2026-08-06' };
      const [migrated] = migrateRecurrenceState([plain]);
      expect(migrated).toBe(plain);
    });

    it('leaves a recurring task with no due date alone (nothing to anchor yet)', () => {
      const undated = recurringTask({ dueDate: null });
      const [migrated] = migrateRecurrenceState([undated]);
      expect(migrated).toBe(undated);
    });

    it('leaves an already-migrated task alone', () => {
      const already = recurringTask({ recurrenceAnchor: '2026-01-01', completedOccurrences: ['2026-01-01'] });
      const [migrated] = migrateRecurrenceState([already]);
      expect(migrated).toBe(already);
    });
  });

  describe('idempotence and identity', () => {
    it('returns the SAME array reference when nothing needed migrating', () => {
      const tasks = [{ id: 't2', isRecurring: false }];
      expect(migrateRecurrenceState(tasks)).toBe(tasks);
    });

    it('is a no-op on a second run', () => {
      const once = migrateRecurrenceState([recurringTask()]);
      expect(migrateRecurrenceState(once)).toBe(once);
    });

    it('tolerates a non-array (corrupt/absent persisted state)', () => {
      expect(migrateRecurrenceState(undefined)).toBeUndefined();
      expect(migrateRecurrenceState(null)).toBeNull();
    });

    it('migrates only the recurring tasks in a mixed list', () => {
      const plain = { id: 'p', isRecurring: false };
      const result = migrateRecurrenceState([plain, recurringTask()]);
      expect(result[0]).toBe(plain);
      expect(result[1].recurrenceAnchor).toBe('2026-08-06');
    });
  });
});
