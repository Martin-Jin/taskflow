import { describe, it, expect } from 'vitest';
import { isBlockTaskCompleted, isBlockDone, isBlockOrTaskDone, isBlockMissed, getMissedTaskItems } from '../../src/utils/missedTasks';

const TODAY = '2026-08-24';

describe('isBlockDone', () => {
  it('is true only when the block itself has status "done"', () => {
    expect(isBlockDone({ status: 'done' })).toBe(true);
    expect(isBlockDone({ status: 'scheduled' })).toBe(false);
    expect(isBlockDone({ status: 'in-progress' })).toBe(false);
    expect(isBlockDone({})).toBe(false);
  });

  it('is false for a null/undefined block rather than throwing', () => {
    expect(isBlockDone(null)).toBe(false);
    expect(isBlockDone(undefined)).toBe(false);
  });
});

describe('isBlockOrTaskDone', () => {
  it('is true when the whole task is completed, even if the block itself was never marked done', () => {
    const block = { status: 'scheduled' };
    const task = { isCompleted: true };
    expect(isBlockOrTaskDone(block, task)).toBe(true);
  });

  it('is true when only the BLOCK is marked done, even though the task overall is not completed', () => {
    // This is the exact case the whole feature exists for: a multi-day
    // task's block for one day finishing doesn't mean the task is done.
    const block = { status: 'done' };
    const task = { isCompleted: false };
    expect(isBlockOrTaskDone(block, task)).toBe(true);
  });

  it('is false when neither the task nor the block is done', () => {
    const block = { status: 'scheduled' };
    const task = { isCompleted: false };
    expect(isBlockOrTaskDone(block, task)).toBe(false);
  });

  it('respects the recurring-task completedDates path for the task-completion half', () => {
    const block = { status: 'scheduled', date: TODAY };
    const task = { isRecurring: true, isCompleted: false, completedDates: [TODAY] };
    expect(isBlockOrTaskDone(block, task)).toBe(true);
  });
});

describe('isBlockMissed — block-level done state (regression: the multi-day "missed" bug)', () => {
  const nowMinutes = 14 * 60; // 2pm

  it('a block whose end time has passed, on an incomplete task, is missed (baseline)', () => {
    const block = { date: TODAY, startTime: '09:00', endTime: '10:00', status: 'scheduled' };
    const task = { isCompleted: false };
    expect(isBlockMissed(block, task, TODAY, nowMinutes)).toBe(true);
  });

  it('is NOT missed once the block itself is marked done, even though the task overall is not complete', () => {
    // The bug this whole feature fixes: a multi-day task's earlier-day block
    // used to show as permanently "missed" because only the TASK's
    // completion was checked, never the block's own. markBlockDone setting
    // status: 'done' must suppress this.
    const block = { date: TODAY, startTime: '09:00', endTime: '10:00', status: 'done' };
    const task = { isCompleted: false };
    expect(isBlockMissed(block, task, TODAY, nowMinutes)).toBe(false);
  });

  it('is still not missed once the whole task is completed (existing behavior, unaffected)', () => {
    const block = { date: TODAY, startTime: '09:00', endTime: '10:00', status: 'scheduled' };
    const task = { isCompleted: true };
    expect(isBlockMissed(block, task, TODAY, nowMinutes)).toBe(false);
  });

  it('a block whose end time has NOT passed yet is never missed regardless of status', () => {
    const block = { date: TODAY, startTime: '15:00', endTime: '16:00', status: 'scheduled' };
    const task = { isCompleted: false };
    expect(isBlockMissed(block, task, TODAY, nowMinutes)).toBe(false);
  });
});

describe('getMissedTaskItems — block-done blocks are excluded', () => {
  it('does not include a block marked done, even past its end time', () => {
    const tasks = [{ id: 't1', title: 'Multi-day task', isCompleted: false }];
    const blocks = [
      { id: 'b1', taskId: 't1', date: TODAY, startTime: '09:00', endTime: '10:00', status: 'done' },
      { id: 'b2', taskId: 't1', date: TODAY, startTime: '11:00', endTime: '12:00', status: 'scheduled' },
    ];
    const now = new Date(`${TODAY}T14:00:00`);
    const items = getMissedTaskItems(tasks, blocks, now);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('b2');
  });
});
