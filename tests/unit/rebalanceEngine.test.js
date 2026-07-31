import { describe, it, expect } from 'vitest';
import { rebalance, planToday } from '../../src/algorithms/rebalanceEngine';

const baseRules = {
  workDayStart: '09:00',
  workDayEnd: '17:00',
  maxDailyDeepWorkHours: 8,
  minGapBetweenBlocksMins: 0,
  horizonWeeks: 1,
};

// 2026-07-01 is a Wednesday.
const today = '2026-07-01';

describe('rebalance', () => {
  it('preserves a completed non-recurring task\'s unlocked block for today instead of clearing it', () => {
    const tasks = [
      { id: 't1', title: 'Done today', isCompleted: true, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b1', taskId: 't1', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b1')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it('preserves a completed recurring occurrence\'s block for today', () => {
    const tasks = [
      {
        id: 't2',
        title: 'Recurring done today',
        isRecurring: true,
        isCompleted: false,
        completedDates: [today],
        estimatedHours: 1,
        dueDate: today,
      },
    ];
    const existingBlocks = [
      { id: 'b2', taskId: 't2', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b2')).toBe(true);
  });

  it('still clears an unlocked, unfinished task\'s block for today', () => {
    const tasks = [
      { id: 't3', title: 'Not done', isCompleted: false, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b3', taskId: 't3', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.stats.blocksCleared).toBe(1);
  });
});

describe('planToday', () => {
  it('preserves a completed task\'s unlocked block for today instead of clearing it', () => {
    const tasks = [
      { id: 't1', title: 'Done today', isCompleted: true, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b1', taskId: 't1', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = planToday({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b1')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it('still clears an unlocked, unfinished task\'s block for today', () => {
    const tasks = [
      { id: 't3', title: 'Not done', isCompleted: false, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b3', taskId: 't3', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = planToday({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.stats.blocksCleared).toBe(1);
  });
});
