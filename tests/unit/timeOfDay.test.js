/**
 * Coverage for the time-of-day preference: the window vocabulary, the overlap
 * measurement it rests on, and the cost term that actually moves the scheduler.
 *
 * The overlap maths matters more than it looks: charging per minute actually
 * outside the window (rather than "does this block start in it") is what gives
 * the refinement search a gradient to follow. Without it a 3-hour morning task
 * starting at 11:00 scores the same as one starting at 20:00, and no move ever
 * looks like an improvement.
 */

import { describe, it, expect } from 'vitest';
import {
  TIME_OF_DAY_WINDOWS,
  TIME_OF_DAY_OPTIONS,
  TIME_OF_DAY_LABELS,
  resolveTimeOfDayWindow,
  minutesOutsidePreference,
} from '../../src/utils/timeOfDay';
import { evaluatePlacementCost, TIME_OF_DAY_PENALTY_PER_HOUR, PRIORITY_MULTIPLIER } from '../../src/algorithms/placementCost';

const span = (startHour, endHour) => ({ startMinute: startHour * 60, endMinute: endHour * 60 });

describe('time-of-day windows', () => {
  it('covers the three periods, in day order, each with a label', () => {
    expect(TIME_OF_DAY_OPTIONS).toEqual(['morning', 'afternoon', 'evening']);
    for (const period of TIME_OF_DAY_OPTIONS) {
      expect(TIME_OF_DAY_WINDOWS[period].start).toBeLessThan(TIME_OF_DAY_WINDOWS[period].end);
      expect(typeof TIME_OF_DAY_LABELS[period]).toBe('string');
    }
  });

  it('does not overlap adjacent periods', () => {
    expect(TIME_OF_DAY_WINDOWS.morning.end).toBe(TIME_OF_DAY_WINDOWS.afternoon.start);
    expect(TIME_OF_DAY_WINDOWS.afternoon.end).toBe(TIME_OF_DAY_WINDOWS.evening.start);
  });

  it('resolves an unknown or absent preference to null', () => {
    expect(resolveTimeOfDayWindow(undefined)).toBeNull();
    expect(resolveTimeOfDayWindow('midnight')).toBeNull();
  });
});

describe('minutesOutsidePreference', () => {
  it('is zero for a block fully inside its window', () => {
    expect(minutesOutsidePreference(span(9, 11), 'morning')).toBe(0);
  });

  it('is the whole duration for a block fully outside', () => {
    expect(minutesOutsidePreference(span(19, 21), 'morning')).toBe(120);
  });

  it('charges only the part that spills over the boundary', () => {
    // 11:00–14:00 against a morning window ending at 12:00 → 2h outside.
    expect(minutesOutsidePreference(span(11, 14), 'morning')).toBe(120);
    // 10:00–13:00 → only the 13th hour... i.e. 12:00-13:00 → 60 outside.
    expect(minutesOutsidePreference(span(10, 13), 'morning')).toBe(60);
  });

  it('charges the full duration for a block entirely before the window opens', () => {
    // Morning starts at 05:00, so a 03:00-04:00 block is wholly outside.
    expect(minutesOutsidePreference(span(3, 4), 'morning')).toBe(60);
  });

  it('is zero without a preference, so an unset task costs nothing', () => {
    expect(minutesOutsidePreference(span(19, 21), null)).toBe(0);
    expect(minutesOutsidePreference(span(19, 21), undefined)).toBe(0);
  });

  it('handles a zero-length or missing span without dividing by anything', () => {
    expect(minutesOutsidePreference(span(9, 9), 'morning')).toBe(0);
    expect(minutesOutsidePreference(null, 'morning')).toBe(0);
  });
});

describe('placementCost — the time-of-day term', () => {
  const block = (startTime, endTime, durationHours) => ({
    id: `b-${startTime}`,
    taskId: 't1',
    date: '2026-09-15',
    startTime,
    endTime,
    durationHours,
  });
  const task = (over = {}) => ({ id: 't1', title: 'T', priority: 'medium', dueDate: '2026-09-20', ...over });
  const costOf = (t, blocks) => evaluatePlacementCost(blocks, [t], (x) => x.dueDate).byTask.get('t1');

  it('is zero when no preference is set', () => {
    expect(costOf(task(), [block('19:00', '21:00', 2)]).timeOfDay).toBe(0);
  });

  it('is zero when the work already sits in the preferred window', () => {
    expect(costOf(task({ preferredTimeOfDay: 'morning' }), [block('09:00', '11:00', 2)]).timeOfDay).toBe(0);
  });

  it('charges per hour outside the window', () => {
    const c = costOf(task({ preferredTimeOfDay: 'morning' }), [block('19:00', '21:00', 2)]);
    expect(c.timeOfDay).toBeCloseTo(2 * TIME_OF_DAY_PENALTY_PER_HOUR, 6);
  });

  it('gives the search a gradient — closer to the window costs less', () => {
    // This is the property the whole term exists for.
    const straddling = costOf(task({ preferredTimeOfDay: 'morning' }), [block('11:00', '13:00', 2)]);
    const farAway = costOf(task({ preferredTimeOfDay: 'morning' }), [block('19:00', '21:00', 2)]);
    expect(straddling.timeOfDay).toBeGreaterThan(0);
    expect(straddling.timeOfDay).toBeLessThan(farAway.timeOfDay);
  });

  it('scales by priority, like the other terms', () => {
    const urgent = costOf(task({ preferredTimeOfDay: 'morning', priority: 'urgent' }), [block('19:00', '21:00', 2)]);
    const low = costOf(task({ preferredTimeOfDay: 'morning', priority: 'low' }), [block('19:00', '21:00', 2)]);
    expect(urgent.timeOfDay / low.timeOfDay).toBeCloseTo(PRIORITY_MULTIPLIER.urgent / PRIORITY_MULTIPLIER.low, 6);
  });

  it('sums across a task split into several blocks', () => {
    const c = costOf(task({ preferredTimeOfDay: 'morning' }), [block('09:00', '10:00', 1), block('20:00', '21:00', 1)]);
    expect(c.timeOfDay).toBeCloseTo(1 * TIME_OF_DAY_PENALTY_PER_HOUR, 6);
  });

  it('contributes to the task total alongside the other terms', () => {
    const t = task({ preferredTimeOfDay: 'morning' });
    const blocks = [block('19:00', '21:00', 2)];
    const c = costOf(t, blocks);
    expect(c.total).toBeCloseTo(c.fragmentation + c.dueDate + c.timeOfDay, 6);
  });

  it('stays weaker than a day of fragmentation for a typical 2-hour block', () => {
    /* The preference should decide a close call, not outrank real scheduling
       concerns — it must never be worth shredding a task across an extra day
       to chase a nicer hour. */
    const spread = evaluatePlacementCost(
      [block('09:00', '10:00', 1), { ...block('09:00', '10:00', 1), id: 'b2', date: '2026-09-16' }],
      [task({ preferredTimeOfDay: 'morning' })],
      (x) => x.dueDate
    ).byTask.get('t1');
    const wrongHour = costOf(task({ preferredTimeOfDay: 'morning' }), [block('19:00', '21:00', 2)]);
    expect(spread.fragmentation).toBeGreaterThan(wrongHour.timeOfDay);
  });

  it('is unaffected by a preference when the task has no blocks at all', () => {
    expect(costOf(task({ preferredTimeOfDay: 'morning' }), []).timeOfDay).toBe(0);
  });
});
