import { describe, it, expect } from 'vitest';
import { subtractIntervals, toTimeIntervals, totalMinutes, capTotalMinutes } from '../../src/utils/intervalUtils';

describe('subtractIntervals', () => {
  it('returns the full container when there is no busy time', () => {
    const result = subtractIntervals({ start: 0, end: 100 }, []);
    expect(result).toEqual([{ start: 0, end: 100 }]);
  });

  it('merges overlapping busy intervals before subtracting', () => {
    const result = subtractIntervals({ start: 0, end: 100 }, [
      { start: 10, end: 40 },
      { start: 30, end: 60 },
    ]);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 60, end: 100 },
    ]);
  });

  it('merges adjacent (touching) busy intervals into a single gap', () => {
    const result = subtractIntervals({ start: 0, end: 100 }, [
      { start: 10, end: 40 },
      { start: 40, end: 60 },
    ]);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 60, end: 100 },
    ]);
  });

  it('handles a busy interval that fully contains another busy interval', () => {
    const result = subtractIntervals({ start: 0, end: 100 }, [
      { start: 10, end: 90 },
      { start: 20, end: 30 },
    ]);
    expect(result).toEqual([
      { start: 0, end: 10 },
      { start: 90, end: 100 },
    ]);
  });

  it('handles a busy interval that fully covers the container, leaving no free time', () => {
    const result = subtractIntervals({ start: 10, end: 20 }, [{ start: 0, end: 100 }]);
    expect(result).toEqual([]);
  });

  it('ignores busy intervals entirely outside the container', () => {
    const result = subtractIntervals({ start: 50, end: 100 }, [{ start: 0, end: 20 }]);
    expect(result).toEqual([{ start: 50, end: 100 }]);
  });

  it('clips a busy interval that only partially overlaps the container boundary', () => {
    const result = subtractIntervals({ start: 50, end: 100 }, [
      { start: 40, end: 60 },
      { start: 90, end: 120 },
    ]);
    expect(result).toEqual([{ start: 60, end: 90 }]);
  });

  it('returns [] for a zero-length container', () => {
    const result = subtractIntervals({ start: 50, end: 50 }, []);
    expect(result).toEqual([]);
  });

  it('splits the free region at a zero-length busy interval instead of collapsing it away', () => {
    // A zero-length busy interval contributes no busy TIME, but since it still
    // passes the overlap filter (b.end > container.start) it splits the
    // single free region into two adjacent ones rather than being ignored.
    const result = subtractIntervals({ start: 0, end: 100 }, [{ start: 50, end: 50 }]);
    expect(result).toEqual([
      { start: 0, end: 50 },
      { start: 50, end: 100 },
    ]);
  });
});

describe('totalMinutes', () => {
  it('sums durations across multiple intervals', () => {
    expect(
      totalMinutes([
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ])
    ).toBe(60);
  });

  it('returns 0 for an empty list', () => {
    expect(totalMinutes([])).toBe(0);
  });

  it('returns 0 for a single zero-length interval', () => {
    expect(totalMinutes([{ start: 10, end: 10 }])).toBe(0);
  });
});

describe('capTotalMinutes', () => {
  it('returns all intervals unchanged when under the cap', () => {
    const intervals = [
      { start: 0, end: 30 },
      { start: 60, end: 90 },
    ];
    expect(capTotalMinutes(intervals, 120)).toEqual(intervals);
  });

  it('truncates an interval that straddles the cap boundary exactly', () => {
    const intervals = [
      { start: 0, end: 30 },
      { start: 60, end: 100 },
    ];
    // Cap = 50: first interval uses 30, second interval gets truncated to 20 more.
    expect(capTotalMinutes(intervals, 50)).toEqual([
      { start: 0, end: 30 },
      { start: 60, end: 80 },
    ]);
  });

  it('drops intervals entirely once the cap has already been reached', () => {
    const intervals = [
      { start: 0, end: 30 },
      { start: 60, end: 90 },
      { start: 100, end: 130 },
    ];
    expect(capTotalMinutes(intervals, 30)).toEqual([{ start: 0, end: 30 }]);
  });

  it('handles a cap that lands exactly on an interval boundary (no truncation needed)', () => {
    const intervals = [
      { start: 0, end: 30 },
      { start: 60, end: 90 },
    ];
    expect(capTotalMinutes(intervals, 60)).toEqual(intervals);
  });

  it('returns [] when the cap is 0', () => {
    expect(capTotalMinutes([{ start: 0, end: 30 }], 0)).toEqual([]);
  });

  it('returns [] for an empty interval list', () => {
    expect(capTotalMinutes([], 60)).toEqual([]);
  });
});

describe('toTimeIntervals', () => {
  it('converts minute-based intervals back to HH:MM pairs', () => {
    const result = toTimeIntervals([
      { start: 0, end: 90 },
      { start: 570, end: 600 },
    ]);
    expect(result).toEqual([
      { start: '00:00', end: '01:30' },
      { start: '09:30', end: '10:00' },
    ]);
  });

  it('returns [] for an empty list', () => {
    expect(toTimeIntervals([])).toEqual([]);
  });
});
