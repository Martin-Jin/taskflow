/**
 * Coverage for the configurable week start.
 *
 * The modulo in startOfWeek is the kind of expression that looks right and is
 * wrong for six days out of seven, so every weekday is checked against both
 * settings rather than spot-checking one.
 */

import { describe, it, expect } from 'vitest';
import { startOfWeek, getWeekRange, dayOfWeek, addDays } from '../../src/utils/dateUtils';

// 2026-08-16 is a Sunday, so this covers Sun..Sat in order.
const WEEK = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'];

describe('startOfWeek', () => {
  it('defaults to Sunday, matching what every week view did before this was configurable', () => {
    for (const iso of WEEK) expect(startOfWeek(iso)).toBe('2026-08-16');
  });

  it('honours a Monday start for every day of the week', () => {
    // The Sunday is the interesting one: with a Monday start it belongs to the
    // PREVIOUS week, which a naive `-dayOfWeek(iso)` gets wrong.
    expect(startOfWeek('2026-08-16', 1)).toBe('2026-08-10');
    for (const iso of WEEK.slice(1)) expect(startOfWeek(iso, 1)).toBe('2026-08-17');
  });

  it('always returns a date whose weekday IS the configured start', () => {
    for (let i = 0; i < 40; i += 1) {
      const iso = addDays('2026-08-01', i);
      expect(dayOfWeek(startOfWeek(iso, 0))).toBe(0);
      expect(dayOfWeek(startOfWeek(iso, 1))).toBe(1);
    }
  });

  it('never returns a date in the future, and never more than 6 days back', () => {
    for (let i = 0; i < 40; i += 1) {
      const iso = addDays('2026-08-01', i);
      for (const start of [0, 1]) {
        const ws = startOfWeek(iso, start);
        expect(ws <= iso).toBe(true);
        expect(ws >= addDays(iso, -6)).toBe(true);
      }
    }
  });
});

describe('getWeekRange', () => {
  it('returns an inclusive 7-day span for either start', () => {
    expect(getWeekRange('2026-08-22')).toEqual({ weekStart: '2026-08-16', weekEnd: '2026-08-22' });
    expect(getWeekRange('2026-08-22', 1)).toEqual({ weekStart: '2026-08-17', weekEnd: '2026-08-23' });
  });

  it('spans a month boundary correctly', () => {
    expect(getWeekRange('2026-09-01', 1)).toEqual({ weekStart: '2026-08-31', weekEnd: '2026-09-06' });
  });
});
