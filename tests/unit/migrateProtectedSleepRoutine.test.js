import { describe, it, expect } from 'vitest';
import { ensureProtectedSleepRoutine } from '../../src/migrations/migrateProtectedSleepRoutine';

describe('ensureProtectedSleepRoutine', () => {
  it('backfills a protected Sleep routine when the user has zero fixed routines', () => {
    const ensured = ensureProtectedSleepRoutine([]);
    expect(ensured.length).toBeGreaterThan(0);
    expect(ensured.every((r) => r.label.toLowerCase().includes('sleep'))).toBe(true);
    expect(ensured.every((r) => r.isProtected === true)).toBe(true);
  });

  it('appends a protected Sleep routine when other routines exist but none is labeled "Sleep"', () => {
    const existing = [
      { id: 'rt_lunch', label: 'Lunch', startTime: '12:30', endTime: '13:15', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const ensured = ensureProtectedSleepRoutine(existing);
    expect(ensured).not.toBe(existing);
    expect(ensured[0]).toBe(existing[0]); // untouched routine keeps its reference
    expect(ensured.some((r) => r.label.toLowerCase() === 'sleep' && r.isProtected === true)).toBe(true);
  });

  it('does not touch a renamed Sleep routine (label no longer matches) — it still counts as having none, so one is added back', () => {
    const existing = [
      { id: 'rt_sleep', label: 'Bedtime', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const ensured = ensureProtectedSleepRoutine(existing);
    expect(ensured[0]).toBe(existing[0]); // the renamed routine is left completely alone
    expect(ensured.some((r) => r.label.toLowerCase() === 'sleep')).toBe(true);
  });

  it('is a no-op when a "Sleep"-labeled routine already exists, protected or not', () => {
    const existing = [
      { id: 'rt_sleep', label: 'Sleep', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const ensured = ensureProtectedSleepRoutine(existing);
    expect(ensured).toBe(existing); // same reference: no-op, no pointless write
  });

  it('matches "Sleep" case/whitespace-insensitively', () => {
    const existing = [
      { id: 'rt_sleep', label: '  SLEEP  ', startTime: '23:00', endTime: '07:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true },
    ];
    const ensured = ensureProtectedSleepRoutine(existing);
    expect(ensured).toBe(existing);
  });

  it('is a no-op on non-array input', () => {
    expect(ensureProtectedSleepRoutine(null)).toBe(null);
    expect(ensureProtectedSleepRoutine(undefined)).toBe(undefined);
  });
});
