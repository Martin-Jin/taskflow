/**
 * Coverage for getEffectiveDeadline, the one rule that decides how much
 * deadline pressure a task is under.
 *
 * It exists as a shared export because Stats re-derived it as a bare
 * `dueDate - bufferDays` and thereby dropped the enforceDueDate carve-out: a
 * task explicitly marked "must be done on its due date" was reported
 * permanently at risk of missing a buffer it doesn't have, while the scheduler
 * simultaneously treated it as on time. These tests pin the carve-out so the
 * two can't drift apart again.
 */

import { describe, it, expect } from 'vitest';
import { getEffectiveDeadline } from '../../src/algorithms/allocator';

const task = (over) => ({ id: 't', dueDate: '2026-09-10', ...over });
// A Map: findAncestorDueDate calls .get() on it, so a plain object silently
// throws the moment a sub-task needs its parent's date.
const byId = (list) => new Map(list.map((t) => [t.id, t]));

describe('getEffectiveDeadline', () => {
  it('pulls the deadline forward by the buffer for an ordinary task', () => {
    expect(getEffectiveDeadline(task(), 1, byId([task()]))).toBe('2026-09-09');
    expect(getEffectiveDeadline(task(), 3, byId([task()]))).toBe('2026-09-07');
  });

  it('is the due date itself when the task must be done on the day', () => {
    // THE case: enforceDueDate collapses the planning window to the due date,
    // so there is no buffer to miss and nothing to subtract.
    const t = task({ enforceDueDate: true });
    expect(getEffectiveDeadline(t, 1, byId([t]))).toBe('2026-09-10');
    expect(getEffectiveDeadline(t, 5, byId([t]))).toBe('2026-09-10');
  });

  it('still applies the buffer when enforceDueDate is set but there is no own due date', () => {
    // enforceDueDate without a dueDate of its own can only mean the inherited
    // one, which is a "finish by" date like any other.
    const parent = { id: 'p', dueDate: '2026-09-10' };
    const child = { id: 'c', parentId: 'p', enforceDueDate: true, dueDate: null };
    expect(getEffectiveDeadline(child, 1, byId([parent, child]))).toBe('2026-09-09');
  });

  it('resolves an undated sub-task through its parent', () => {
    // The inline version Stats used couldn't see this at all — it required
    // t.dueDate and skipped the task otherwise.
    const parent = { id: 'p', dueDate: '2026-09-10' };
    const child = { id: 'c', parentId: 'p', dueDate: null };
    expect(getEffectiveDeadline(child, 2, byId([parent, child]))).toBe('2026-09-08');
  });

  it('returns null when there is no due date anywhere to resolve', () => {
    const t = { id: 'x', dueDate: null };
    expect(getEffectiveDeadline(t, 1, byId([t]))).toBeNull();
  });

  it('crosses a month boundary correctly', () => {
    const t = task({ dueDate: '2026-09-01' });
    expect(getEffectiveDeadline(t, 3, byId([t]))).toBe('2026-08-29');
  });

  it('treats a zero buffer as "due date is the deadline"', () => {
    expect(getEffectiveDeadline(task(), 0, byId([task()]))).toBe('2026-09-10');
  });
});
