/**
 * Coverage for clipOutsideRange, which carves a day's free time into the part
 * outside working hours.
 *
 * It backs one behaviour: a task with an explicit fixed time may be scheduled
 * beyond the work window. Getting the complement wrong in either direction is
 * silent — too much and ordinary tasks could be double-booked against
 * out-of-hours placements, too little and a fixed time at 21:00 still never
 * schedules.
 */

import { describe, it, expect } from 'vitest';
import { clipOutsideRange } from '../../src/utils/intervalUtils';

const WORK = { start: 7 * 60, end: 23 * 60 }; // 07:00-23:00

describe('clipOutsideRange', () => {
  it('returns the slices before and after the range', () => {
    // A whole free day minus working hours = early morning + late night.
    expect(clipOutsideRange([{ start: 0, end: 24 * 60 }], WORK)).toEqual([
      { start: 0, end: 420 },
      { start: 1380, end: 1440 },
    ]);
  });

  it('drops an interval entirely inside the range', () => {
    // That time belongs to the in-hours pool, which is tracked separately.
    expect(clipOutsideRange([{ start: 600, end: 700 }], WORK)).toEqual([]);
  });

  it('keeps an interval entirely outside the range untouched', () => {
    expect(clipOutsideRange([{ start: 1400, end: 1440 }], WORK)).toEqual([{ start: 1400, end: 1440 }]);
  });

  it('clips an interval that straddles the range start', () => {
    expect(clipOutsideRange([{ start: 300, end: 600 }], WORK)).toEqual([{ start: 300, end: 420 }]);
  });

  it('clips an interval that straddles the range end', () => {
    expect(clipOutsideRange([{ start: 1300, end: 1440 }], WORK)).toEqual([{ start: 1380, end: 1440 }]);
  });

  it('never returns a zero- or negative-length slice', () => {
    // An interval that merely touches the boundary contributes nothing.
    expect(clipOutsideRange([{ start: 420, end: 420 }], WORK)).toEqual([]);
    expect(clipOutsideRange([{ start: 0, end: 420 }], WORK)).toEqual([{ start: 0, end: 420 }]);
    expect(clipOutsideRange([{ start: 1380, end: 1380 }], WORK)).toEqual([]);
  });

  it('returns everything when there is no range at all', () => {
    // A day marked not-working resolves to no usable window; a fixed time on
    // such a day should still be placeable.
    const all = [{ start: 0, end: 1440 }];
    expect(clipOutsideRange(all, null)).toEqual(all);
  });

  it('treats a zero-length window as "the whole day is outside it"', () => {
    // resolveWorkWindow collapses a not-working day to start === end.
    const closed = { start: 540, end: 540 };
    expect(clipOutsideRange([{ start: 0, end: 1440 }], closed)).toEqual([
      { start: 0, end: 540 },
      { start: 540, end: 1440 },
    ]);
  });

  it('does not mutate its input, and tolerates nothing', () => {
    const input = [{ start: 0, end: 1440 }];
    clipOutsideRange(input, WORK);
    expect(input).toEqual([{ start: 0, end: 1440 }]);
    expect(clipOutsideRange(undefined, WORK)).toEqual([]);
  });
});
