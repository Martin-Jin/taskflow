import { describe, it, expect } from 'vitest';
import { getTaskScheduledBlocks } from '../../src/utils/taskScheduledBlocks';

const block = (id, date, startTime = '09:00') => ({ id, taskId: 't', date, startTime });
const daily = { id: 't', isRecurring: true, dueDate: '2026-11-04' };

describe('getTaskScheduledBlocks', () => {
  it('returns every block of a non-recurring task', () => {
    const task = { id: 't', isRecurring: false };
    const blocks = [block('b2', '2026-11-06'), block('b1', '2026-11-05')];
    expect(getTaskScheduledBlocks(task, blocks).map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('shows only the current occurrence\'s blocks for a recurring task', () => {
    const blocks = [block('old', '2026-10-28'), block('cur', '2026-11-04'), block('next', '2026-11-05')];
    expect(getTaskScheduledBlocks(daily, blocks).map((b) => b.id)).toEqual(['cur']);
  });

  it('skips a finished past occurrence\'s stale block when the overdue current occurrence has none', () => {
    // Oct 28 was completed and kept as a record; Nov 4 is overdue with no block;
    // Nov 5 is where the scheduler placed the next one.
    const blocks = [block('old', '2026-10-28'), block('next', '2026-11-05'), block('later', '2026-11-06')];
    expect(getTaskScheduledBlocks(daily, blocks).map((b) => b.id)).toEqual(['next']);
  });

  it('returns nothing when every block is before the current occurrence', () => {
    expect(getTaskScheduledBlocks(daily, [block('old', '2026-10-28')])).toEqual([]);
  });
});
