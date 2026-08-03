/**
 * ============================================================================
 * useNowAndNext — "Right now" / "Today's agenda" selection logic
 * ============================================================================
 * Covers computeNowAndNext (src/hooks/useNowAndNext.js), the pure decision
 * extracted out of the `now`-ticking hook so it's testable without mounting
 * a component. Two bugs motivated this coverage:
 *   - Recurring calendar events (self-created, e.g. a weekly gym slot) were
 *     never expanded per-occurrence here, so they'd only ever appear on the
 *     exact date of their FIRST occurrence and silently vanish every other
 *     week — fixed by routing events through expandEventsForRange.
 *   - When two blocks/events overlap the current moment (or the next slot),
 *     only the earliest-starting one used to surface at all; the other was
 *     dropped with no indication anything else was happening — fixed by
 *     reporting `overlapCount` alongside the chosen item.
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import { computeNowAndNext } from '../../src/hooks/useNowAndNext.js';

function block(id, taskId, date, startTime, endTime) {
  return { id, taskId, date, startTime, endTime };
}
function task(id, title) {
  return { id, title };
}
function event(id, date, startTime, endTime, extra = {}) {
  return { id, title: id, date, startTime, endTime, ...extra };
}

describe('computeNowAndNext', () => {
  it('picks the block in progress as current', () => {
    const now = new Date('2026-08-04T10:30:00');
    const tasks = [task('t1', 'Piano')];
    const blocks = [block('b1', 't1', '2026-08-04', '10:10', '11:10')];
    const result = computeNowAndNext(tasks, blocks, [], now);
    expect(result.current.kind).toBe('block');
    expect(result.current.task.title).toBe('Piano');
    expect(result.current.overlapCount).toBe(0);
  });

  it('surfaces a calendar event as current, not just task blocks', () => {
    const now = new Date('2026-08-04T09:30:00');
    const events = [event('gym', '2026-08-04', '09:00', '10:00')];
    const result = computeNowAndNext([], [], events, now);
    expect(result.current.kind).toBe('event');
    expect(result.current.event.id).toBe('gym');
  });

  it('expands a recurring event onto today even when its stored master date is a different week', () => {
    const now = new Date('2026-08-04T09:30:00');
    // Master's own `date` is the first-ever occurrence, three weeks ago.
    const events = [event('gym', '2026-07-14', '09:00', '10:00', { recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU' })];
    const result = computeNowAndNext([], [], events, now);
    expect(result.current).not.toBeNull();
    expect(result.current.kind).toBe('event');
    expect(result.current.date).toBe('2026-08-04');
  });

  it('reports overlapCount instead of silently dropping simultaneous items', () => {
    const now = new Date('2026-08-04T10:15:00');
    const tasks = [task('t1', 'Piano'), task('t2', 'Scholarship check')];
    const blocks = [
      block('b1', 't1', '2026-08-04', '10:10', '11:10'),
      block('b2', 't2', '2026-08-04', '10:10', '10:20'),
    ];
    const result = computeNowAndNext(tasks, blocks, [], now);
    // Earliest-starting (tie -> array order) wins the primary slot...
    expect(result.current.task.title).toBe('Piano');
    // ...but the other simultaneous item is still accounted for.
    expect(result.current.overlapCount).toBe(1);
  });

  it('reports overlapCount for the "next" slot too', () => {
    const now = new Date('2026-08-04T09:00:00');
    const tasks = [task('t1', 'Piano'), task('t2', 'Scholarship check')];
    const blocks = [
      block('b1', 't1', '2026-08-04', '10:10', '11:10'),
      block('b2', 't2', '2026-08-04', '10:10', '10:20'),
    ];
    const result = computeNowAndNext(tasks, blocks, [], now);
    expect(result.next.overlapCount).toBe(1);
  });

  it('returns current/next as null when nothing is scheduled', () => {
    const now = new Date('2026-08-04T09:00:00');
    const result = computeNowAndNext([], [], [], now);
    expect(result.current).toBeNull();
    expect(result.next).toBeNull();
  });
});
