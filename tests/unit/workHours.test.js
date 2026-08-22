/**
 * Coverage for per-weekday work hours. The property that matters most is the
 * first block: rules saved before this feature existed must resolve to exactly
 * the old behaviour, because there is no migration — the whole design rests on
 * the absent-map case being indistinguishable from before.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveWorkWindow,
  hasPerDayWorkHours,
  seedPerDayWorkHours,
  WEEKDAY_ORDER,
  WEEKDAY_NAMES,
} from '../../src/utils/workHours';

// 2026-09-14 is a Monday, so 09-19 is Saturday and 09-20 is Sunday.
const MONDAY = '2026-09-14';
const SATURDAY = '2026-09-19';
const SUNDAY = '2026-09-20';

const base = { workDayStart: '09:00', workDayEnd: '17:00' };

describe('resolveWorkWindow — no overrides (rules saved before this existed)', () => {
  it('uses the baseline pair for every day of the week', () => {
    for (const date of [MONDAY, SATURDAY, SUNDAY, '2026-09-16']) {
      expect(resolveWorkWindow(base, date)).toEqual({
        start: '09:00',
        end: '17:00',
        enabled: true,
        isOverride: false,
      });
    }
  });

  it('treats an empty override map as no overrides', () => {
    expect(resolveWorkWindow({ ...base, workHoursByDay: {} }, MONDAY).isOverride).toBe(false);
  });

  it('falls back to a full day when the baseline itself is missing', () => {
    const w = resolveWorkWindow({}, MONDAY);
    expect(w.start).toBe('00:00');
    expect(w.end).toBe('23:59');
  });

  it('tolerates null rules rather than throwing', () => {
    expect(resolveWorkWindow(null, MONDAY).enabled).toBe(true);
  });
});

describe('resolveWorkWindow — per-weekday overrides', () => {
  it('applies an override only to its own weekday', () => {
    const rules = { ...base, workHoursByDay: { 6: { start: '10:00', end: '12:00' } } };
    expect(resolveWorkWindow(rules, SATURDAY)).toEqual({
      start: '10:00',
      end: '12:00',
      enabled: true,
      isOverride: true,
    });
    // Monday is untouched.
    expect(resolveWorkWindow(rules, MONDAY).start).toBe('09:00');
    expect(resolveWorkWindow(rules, MONDAY).isOverride).toBe(false);
  });

  it('lets an override change just one end of the window', () => {
    const rules = { ...base, workHoursByDay: { 1: { start: '06:00' } } };
    const w = resolveWorkWindow(rules, MONDAY);
    expect(w.start).toBe('06:00');
    expect(w.end).toBe('17:00'); // inherited from the baseline
  });

  it('treats a day off as a zero-length window', () => {
    // Expressed this way so the capacity engine needs no "day off" branch —
    // zero-length falls out of the existing interval maths as zero capacity.
    const rules = { ...base, workHoursByDay: { 0: { start: '09:00', end: '17:00', enabled: false } } };
    const w = resolveWorkWindow(rules, SUNDAY);
    expect(w.enabled).toBe(false);
    expect(w.start).toBe(w.end);
  });

  it('defaults enabled to true when an override omits it', () => {
    const rules = { ...base, workHoursByDay: { 1: { start: '08:00', end: '16:00' } } };
    expect(resolveWorkWindow(rules, MONDAY).enabled).toBe(true);
  });
});

describe('hasPerDayWorkHours', () => {
  it('is false without a map, or with an empty one', () => {
    expect(hasPerDayWorkHours(base)).toBe(false);
    expect(hasPerDayWorkHours({ ...base, workHoursByDay: {} })).toBe(false);
    expect(hasPerDayWorkHours(null)).toBe(false);
  });

  it('is true once any day is overridden', () => {
    expect(hasPerDayWorkHours({ ...base, workHoursByDay: { 3: { start: '10:00' } } })).toBe(true);
  });
});

describe('seedPerDayWorkHours', () => {
  it('covers all seven weekdays', () => {
    const map = seedPerDayWorkHours(base);
    expect(Object.keys(map).map(Number).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('carries the baseline times onto every day', () => {
    const map = seedPerDayWorkHours(base);
    for (const day of WEEKDAY_ORDER) {
      expect(map[day].start).toBe('09:00');
      expect(map[day].end).toBe('17:00');
    }
  });

  it('starts weekends as not-working, since that is the point of the feature', () => {
    const map = seedPerDayWorkHours(base);
    expect(map[0].enabled).toBe(false); // Sunday
    expect(map[6].enabled).toBe(false); // Saturday
    for (const day of [1, 2, 3, 4, 5]) expect(map[day].enabled).toBe(true);
  });
});

describe('weekday constants', () => {
  it('orders Monday first and Sunday last, for display', () => {
    expect(WEEKDAY_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('names every day the order references', () => {
    for (const day of WEEKDAY_ORDER) expect(typeof WEEKDAY_NAMES[day]).toBe('string');
  });
});
