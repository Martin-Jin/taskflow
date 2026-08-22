/**
 * ============================================================================
 * INTERVAL ARITHMETIC
 * ============================================================================
 * The scheduling engine's capacity calculation boils down to interval math:
 * start with the full work-day window, subtract every "busy" interval
 * (fixed routines, existing calendar events, already-scheduled task blocks),
 * and what remains is free capacity. All intervals here are expressed as
 * { start, end } in minutes-since-midnight for cheap integer arithmetic.
 * ============================================================================
 */

import { timeToMinutes, minutesToTime } from './dateUtils';

/**
 * Merge overlapping/adjacent intervals into a minimal sorted set.
 * @param {Array<{start:number end:number}>} intervals
 * @returns {Array<{start:number end:number}>}
 */
export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      // Overlapping or touching -> extend the last merged interval.
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Subtract a set of "busy" intervals from a single "container" window,
 * returning the remaining free sub-intervals within that window.
 * @param {{start:number,end:number}} container
 * @param {Array<{start:number end:number}>} busy
 * @returns {Array<{start:number end:number}>}
 */
export function subtractIntervals(container, busy) {
  const merged = mergeIntervals(busy.filter((b) => b.end > container.start && b.start < container.end));
  const free = [];
  let cursor = container.start;

  for (const b of merged) {
    const clampedStart = Math.max(b.start, container.start);
    const clampedEnd = Math.min(b.end, container.end);
    if (clampedStart > cursor) {
      free.push({ start: cursor, end: clampedStart });
    }
    cursor = Math.max(cursor, clampedEnd);
  }
  if (cursor < container.end) {
    free.push({ start: cursor, end: container.end });
  }
  return free;
}

/** Total minutes represented by a list of intervals. */
export function totalMinutes(intervals) {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Convert "HH:MM" interval pairs to minute-based intervals. */
export function toMinuteIntervals(pairs) {
  return pairs.map((p) => ({ start: timeToMinutes(p.start ?? p.startTime), end: timeToMinutes(p.end ?? p.endTime) }));
}

/** Convert minute-based intervals back to "HH:MM" pairs. */
export function toTimeIntervals(intervals) {
  return intervals.map((i) => ({ start: minutesToTime(i.start), end: minutesToTime(i.end) }));
}

/**
 * The parts of `intervals` that fall OUTSIDE `range` — the complement of
 * clipping to it.
 *
 * Exists for one job: a task with an explicit `fixedTime` may be scheduled
 * beyond the day's working hours (see capacityEngine's fixedTimeFreeIntervals
 * and allocator's placeFixedTimeInDay), and the allocator needs those
 * out-of-hours slices as a SEPARATE pool from the in-hours ones. Keeping them
 * separate rather than merging is what stops an out-of-hours placement
 * competing with, or double-booking against, the shared in-hours track every
 * other task draws from — the two pools are disjoint by construction.
 *
 * @param {{start: number, end: number}[]} intervals
 * @param {{start: number, end: number}} range
 * @returns {{start: number, end: number}[]} positive-length slices only
 */
export function clipOutsideRange(intervals, range) {
  if (!range) return (intervals || []).map((iv) => ({ ...iv }));
  const out = [];
  for (const iv of intervals || []) {
    // The slice before the range starts.
    if (iv.start < range.start) out.push({ start: iv.start, end: Math.min(iv.end, range.start) });
    // ...and the slice after it ends.
    if (iv.end > range.end) out.push({ start: Math.max(iv.start, range.end), end: iv.end });
  }
  return out.filter((iv) => iv.end - iv.start > 0);
}
