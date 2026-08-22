import { describe, it, expect } from 'vitest';
import { computeDayCapacity, computeHorizonCapacity } from '../../src/algorithms/capacityEngine';

const baseRules = {
  workDayStart: '09:00',
  workDayEnd: '17:00',
  maxDailyDeepWorkHours: 8,
  minGapBetweenBlocksMins: 0,
};

describe('computeDayCapacity', () => {
  it('returns the full work window as free time when there is nothing busy', () => {
    // 2026-07-01 is a Wednesday.
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events: [], blocks: [] });
    expect(result.totalAvailableHours).toBe(8);
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  // workWindow (minutes-since-midnight) is distinct from freeIntervals -- it's
  // the day's overall working-hours BOUNDS, used by allocator.js's
  // placeFixedTimeInDay to tell "a fixedTime slot is occupied by something"
  // apart from "the slot was never inside working hours at all".
  it('exposes workWindow as the raw work-hours bounds in minutes, independent of busy time carved out of freeIntervals', () => {
    const events = [{ date: '2026-07-01', startTime: '11:00', endTime: '12:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.workWindow).toEqual({ start: 9 * 60, end: 17 * 60 });
  });

  it('nowClamps workWindow.start forward on the current day without affecting other days', () => {
    const nowClamp = { date: '2026-07-01', minutes: 13 * 60 }; // 13:00
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events: [], blocks: [], nowClamp });
    expect(result.workWindow).toEqual({ start: 13 * 60, end: 17 * 60 });
  });

  it('merges routines, events, and blocks into busy time correctly', () => {
    const routines = [{ isActive: true, daysOfWeek: [3], startTime: '09:00', endTime: '10:00' }];
    const events = [{ date: '2026-07-01', startTime: '11:00', endTime: '12:00' }];
    const blocks = [{ date: '2026-07-01', startTime: '13:00', endTime: '14:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines, events, blocks });
    expect(result.freeIntervals).toEqual([
      { start: '10:00', end: '11:00' },
      { start: '12:00', end: '13:00' },
      { start: '14:00', end: '17:00' },
    ]);
    expect(result.totalAvailableHours).toBe(5);
  });

  it('excludes an inactive routine from busy time', () => {
    const routines = [{ isActive: false, daysOfWeek: [3], startTime: '09:00', endTime: '10:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines, events: [], blocks: [] });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(result.totalAvailableHours).toBe(8);
  });

  it('excludes a routine that does not run on this day of week', () => {
    // 2026-07-01 is Wednesday (dow 3); routine only runs on Monday (dow 1).
    const routines = [{ isActive: true, daysOfWeek: [1], startTime: '09:00', endTime: '10:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines, events: [], blocks: [] });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('includes a routine that runs on this day of week', () => {
    const routines = [{ isActive: true, daysOfWeek: [3], startTime: '09:00', endTime: '10:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines, events: [], blocks: [] });
    expect(result.freeIntervals).toEqual([{ start: '10:00', end: '17:00' }]);
  });

  it('treats an isFreeTime event as available rather than busy', () => {
    const events = [{ date: '2026-07-01', startTime: '11:00', endTime: '12:00', isFreeTime: true }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('ignores events/blocks that fall on a different date', () => {
    const events = [{ date: '2026-07-02', startTime: '11:00', endTime: '12:00' }];
    const blocks = [{ date: '2026-07-02', startTime: '13:00', endTime: '14:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('never returns negative free capacity when busy time fully covers the work window', () => {
    const blocks = [{ date: '2026-07-01', startTime: '08:00', endTime: '18:00' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events: [], blocks });
    expect(result.totalAvailableHours).toBe(0);
    expect(result.freeIntervals).toEqual([]);
  });

  it('clamps the work window start forward on the nowClamp date so past time is never scheduled', () => {
    const result = computeDayCapacity('2026-07-01', {
      rules: baseRules,
      routines: [],
      events: [],
      blocks: [],
      nowClamp: { date: '2026-07-01', minutes: 12 * 60 }, // noon
    });
    expect(result.freeIntervals).toEqual([{ start: '12:00', end: '17:00' }]);
  });

  it('does not apply nowClamp to a different date in the horizon', () => {
    const result = computeDayCapacity('2026-07-02', {
      rules: baseRules,
      routines: [],
      events: [],
      blocks: [],
      nowClamp: { date: '2026-07-01', minutes: 12 * 60 },
    });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('pads busy intervals with minGapBetweenBlocksMins on both sides', () => {
    const rules = { ...baseRules, minGapBetweenBlocksMins: 15 };
    const blocks = [{ date: '2026-07-01', startTime: '12:00', endTime: '13:00' }];
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events: [], blocks });
    expect(result.freeIntervals).toEqual([
      { start: '09:00', end: '11:45' },
      { start: '13:15', end: '17:00' },
    ]);
  });

  // Regression coverage: maxDailyDeepWorkHours caps the summary
  // totalAvailableHours stat (used e.g. by StatsDashboard's "free time this
  // week" figure), but must NOT truncate freeIntervals itself — doing so
  // used to delete every slot after the cap from the allocator's own view
  // (e.g. an 09:00-17:00 day with a 2-hour cap collapsed to "09:00-11:00
  // only"), so a task needing a LATER slot that day (a fixedTime task, or a
  // lower-priority task whose earlier hours were already claimed by
  // something else) spuriously saw no capacity even on a mostly-empty day.
  // The cap is enforced instead as a running per-day budget while the
  // allocator actually places blocks (see allocator.js's allocateTasks).
  it('caps totalAvailableHours to maxDailyDeepWorkHours but leaves freeIntervals uncapped', () => {
    const rules = { ...baseRules, maxDailyDeepWorkHours: 2 };
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events: [], blocks: [] });
    expect(result.totalAvailableHours).toBe(2);
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('never returns negative free capacity when nowClamp pushes the work start past the work end', () => {
    const result = computeDayCapacity('2026-07-01', {
      rules: baseRules,
      routines: [],
      events: [],
      blocks: [],
      nowClamp: { date: '2026-07-01', minutes: 20 * 60 }, // 8pm, after the 17:00 work-day end
    });
    expect(result.totalAvailableHours).toBe(0);
    expect(result.freeIntervals).toEqual([]);
  });

  it('tags busyIntervals with source/id/label for routines, events, and blocks', () => {
    const routines = [{ id: 'r1', isActive: true, daysOfWeek: [3], startTime: '09:00', endTime: '10:00', label: 'Gym' }];
    const events = [{ id: 'e1', date: '2026-07-01', startTime: '11:00', endTime: '12:00', title: 'Team Standup' }];
    const blocks = [{ date: '2026-07-01', startTime: '13:00', endTime: '14:00', taskId: 'task-1' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines, events, blocks });
    expect(result.busyIntervals).toEqual([
      { start: 9 * 60, end: 10 * 60, source: 'routine', id: 'r1', label: 'Gym' },
      { start: 11 * 60, end: 12 * 60, source: 'event', id: 'e1', label: 'Team Standup' },
      { start: 13 * 60, end: 14 * 60, source: 'block', id: 'task-1', label: null },
    ]);
  });

  it('excludes an isFreeTime event from busyIntervals just like from freeIntervals', () => {
    const events = [{ id: 'e1', date: '2026-07-01', startTime: '11:00', endTime: '12:00', isFreeTime: true, title: 'Lecture' }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.busyIntervals).toEqual([]);
  });

  it('reports busyIntervals unpadded even when minGapBetweenBlocksMins pads freeIntervals', () => {
    const rules = { ...baseRules, minGapBetweenBlocksMins: 15 };
    const blocks = [{ date: '2026-07-01', startTime: '12:00', endTime: '13:00', taskId: 'task-1' }];
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events: [], blocks });
    expect(result.busyIntervals).toEqual([{ start: 12 * 60, end: 13 * 60, source: 'block', id: 'task-1', label: null }]);
  });
});

describe('computeHorizonCapacity', () => {
  it('computes a DayCapacity for every day in the horizon', () => {
    const map = computeHorizonCapacity('2026-07-01', 3, { rules: baseRules, routines: [], events: [], blocks: [] });
    expect([...map.keys()]).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    for (const cap of map.values()) {
      expect(cap.totalAvailableHours).toBe(8);
    }
  });

  it('applies per-day busy time independently across the horizon', () => {
    const blocks = [{ date: '2026-07-02', startTime: '09:00', endTime: '17:00' }];
    const map = computeHorizonCapacity('2026-07-01', 3, { rules: baseRules, routines: [], events: [], blocks });
    expect(map.get('2026-07-01').totalAvailableHours).toBe(8);
    expect(map.get('2026-07-02').totalAvailableHours).toBe(0);
    expect(map.get('2026-07-03').totalAvailableHours).toBe(8);
  });
});

describe('computeDayCapacity — all-day events', () => {
  /* An all-day event carries 00:00-23:59 rather than a special flag, so the
     busy-interval maths needs no all-day branch at all (see
     googleCalendarService's mapping). These pin the two outcomes that matter:
     a BUSY all-day event flattens the day, and a FREE one is ignored. Google's
     own transparency decides which by default — the difference between a day
     of booked leave and a birthday on a holiday calendar. */
  it('a busy all-day event leaves no capacity at all', () => {
    const events = [{ date: '2026-07-01', startTime: '00:00', endTime: '23:59', isAllDay: true, isFreeTime: false }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.totalAvailableHours).toBe(0);
    expect(result.freeIntervals).toEqual([]);
  });

  it('a free all-day event does not consume any capacity', () => {
    const events = [{ date: '2026-07-01', startTime: '00:00', endTime: '23:59', isAllDay: true, isFreeTime: true }];
    const result = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.totalAvailableHours).toBe(8);
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('only affects its own day', () => {
    const events = [{ date: '2026-07-01', startTime: '00:00', endTime: '23:59', isAllDay: true, isFreeTime: false }];
    const result = computeDayCapacity('2026-07-02', { rules: baseRules, routines: [], events, blocks: [] });
    expect(result.totalAvailableHours).toBe(8);
  });
});

describe('computeDayCapacity — per-weekday work hours', () => {
  /* The scheduling half of utils/workHours.js. 2026-07-01 is a Wednesday,
     2026-07-04 a Saturday — matching the dates the rest of this file uses. */
  it('applies a weekday override instead of the baseline window', () => {
    const rules = { ...baseRules, workHoursByDay: { 3: { start: '10:00', end: '14:00' } } };
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events: [], blocks: [] });
    expect(result.totalAvailableHours).toBe(4);
    expect(result.freeIntervals).toEqual([{ start: '10:00', end: '14:00' }]);
  });

  it('leaves other weekdays on the baseline window', () => {
    const rules = { ...baseRules, workHoursByDay: { 3: { start: '10:00', end: '14:00' } } };
    // Thursday has no override.
    const result = computeDayCapacity('2026-07-02', { rules, routines: [], events: [], blocks: [] });
    expect(result.freeIntervals).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('gives a day marked not-working zero capacity', () => {
    // This is the whole point: a Saturday the user does not work must not be
    // modelled as identically available to a Tuesday.
    const rules = { ...baseRules, workHoursByDay: { 6: { start: '09:00', end: '17:00', enabled: false } } };
    const result = computeDayCapacity('2026-07-04', { rules, routines: [], events: [], blocks: [] });
    expect(result.totalAvailableHours).toBe(0);
    expect(result.freeIntervals).toEqual([]);
  });

  it('still carves busy time out of an overridden window', () => {
    const rules = { ...baseRules, workHoursByDay: { 3: { start: '10:00', end: '14:00' } } };
    const events = [{ date: '2026-07-01', startTime: '11:00', endTime: '12:00' }];
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events, blocks: [] });
    expect(result.freeIntervals).toEqual([
      { start: '10:00', end: '11:00' },
      { start: '12:00', end: '14:00' },
    ]);
  });

  it('reports the overridden bounds as the day workWindow', () => {
    // allocator.js reads workWindow to tell "this slot is taken" apart from
    // "this slot was never inside working hours" — so it has to follow the
    // override too, or a fixed-time task would be judged against the wrong day.
    const rules = { ...baseRules, workHoursByDay: { 3: { start: '10:00', end: '14:00' } } };
    const result = computeDayCapacity('2026-07-01', { rules, routines: [], events: [], blocks: [] });
    expect(result.workWindow).toEqual({ start: 10 * 60, end: 14 * 60 });
  });

  it('behaves identically to the old scalars when no map is present', () => {
    const withMap = computeDayCapacity('2026-07-01', { rules: { ...baseRules, workHoursByDay: {} }, routines: [], events: [], blocks: [] });
    const without = computeDayCapacity('2026-07-01', { rules: baseRules, routines: [], events: [], blocks: [] });
    expect(withMap).toEqual(without);
  });
});
