import { describe, it, expect } from 'vitest';
import { migrateProtectedSleepRoutine } from '../../src/migrations/migrateProtectedSleepRoutine';

describe('migrateProtectedSleepRoutine', () => {
  it('backfills a protected Sleep routine when the user has zero fixed routines', () => {
    const migrated = migrateProtectedSleepRoutine([]);
    expect(migrated.length).toBeGreaterThan(0);
    expect(migrated.every((r) => r.label.toLowerCase().includes('sleep'))).toBe(true);
    expect(migrated.every((r) => r.isProtected === true)).toBe(true);
  });

  it('does not touch an existing routines list, even if it has no Sleep routine at all', () => {
    const existing = [
      { id: 'rt_lunch', label: 'Lunch', startTime: '12:30', endTime: '13:15', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const migrated = migrateProtectedSleepRoutine(existing);
    expect(migrated).toBe(existing); // same reference: no-op, no pointless write
  });

  it('does not touch a renamed Sleep routine (label no longer matches)', () => {
    const existing = [
      { id: 'rt_sleep', label: 'Bedtime', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const migrated = migrateProtectedSleepRoutine(existing);
    expect(migrated).toBe(existing);
  });

  it('marks an existing routine labeled exactly "Sleep" as protected, without changing anything else', () => {
    const existing = [
      { id: 'rt_lunch', label: 'Lunch', startTime: '12:30', endTime: '13:15', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
      { id: 'rt_old_sleep', label: '  Sleep  ', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const migrated = migrateProtectedSleepRoutine(existing);
    expect(migrated).not.toBe(existing);
    expect(migrated[0]).toBe(existing[0]); // untouched routine keeps its reference
    const sleep = migrated.find((r) => r.id === 'rt_old_sleep');
    expect(sleep.isProtected).toBe(true);
    expect(sleep.startTime).toBe('23:00');
    expect(sleep.endTime).toBe('07:00');
  });

  it('does not re-protect a Sleep routine that is already protected (no pointless write)', () => {
    const existing = [
      { id: 'rt_sleep', label: 'Sleep', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true, isProtected: true },
    ];
    const migrated = migrateProtectedSleepRoutine(existing);
    expect(migrated).toBe(existing);
  });

  it('does not re-add a routine the user deliberately deleted, as long as at least one other routine remains', () => {
    const existing = [
      { id: 'rt_hygiene_am', label: 'Morning routine', startTime: '07:00', endTime: '08:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const migrated = migrateProtectedSleepRoutine(existing);
    expect(migrated).toBe(existing);
  });

  it('is a no-op on non-array input', () => {
    expect(migrateProtectedSleepRoutine(null)).toBe(null);
    expect(migrateProtectedSleepRoutine(undefined)).toBe(undefined);
  });
});
