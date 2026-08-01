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

  it("preserves a completed task's PAST (historical) unlocked block instead of clearing it", () => {
    const yesterday = '2026-06-30';
    const tasks = [
      { id: 't4', title: 'Done yesterday', isCompleted: true, estimatedHours: 1, dueDate: yesterday },
    ];
    const existingBlocks = [
      { id: 'b4', taskId: 't4', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b4')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it("clears an incomplete task's stale PAST block and frees its hours so it can be rescheduled onto a future enforced due date", () => {
    const yesterday = '2026-06-30';
    const tomorrow = '2026-07-02';
    const tasks = [
      {
        id: 't5',
        title: 'Stale, moved out',
        isCompleted: false,
        estimatedHours: 1,
        dueDate: tomorrow,
        enforceDueDate: true,
      },
    ];
    const existingBlocks = [
      { id: 'b5', taskId: 't5', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    // Stale past block is gone...
    expect(result.blocks.some((b) => b.id === 'b5')).toBe(false);
    // ...and a fresh block was placed on the real (future) due date instead.
    expect(result.blocks.some((b) => b.taskId === 't5' && b.date === tomorrow)).toBe(true);
    expect(result.overflow.length).toBe(0);
  });

  it('preserves a LOCKED past block even though its task is not completed', () => {
    const yesterday = '2026-06-30';
    const tasks = [
      { id: 't6', title: 'Locked past, not done', isCompleted: false, estimatedHours: 1, dueDate: yesterday },
    ];
    const existingBlocks = [
      { id: 'b6', taskId: 't6', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: true },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b6')).toBe(true);
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

  it("clears an incomplete task's stale PAST block too (not just today's), freeing its hours for today's replan", () => {
    const yesterday = '2026-06-30';
    const tasks = [
      { id: 't4', title: 'Stale past, moved to today', isCompleted: false, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b4', taskId: 't4', date: yesterday, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = planToday({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b4')).toBe(false);
    expect(result.blocks.some((b) => b.taskId === 't4' && b.date === today)).toBe(true);
  });

  it('leaves a FUTURE-dated block completely untouched regardless of completion state', () => {
    const tomorrow = '2026-07-02';
    const tasks = [
      { id: 't5', title: 'Future, not done', isCompleted: false, estimatedHours: 1, dueDate: tomorrow },
    ];
    const existingBlocks = [
      { id: 'b5', taskId: 't5', date: tomorrow, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = planToday({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b5')).toBe(true);
  });
});
