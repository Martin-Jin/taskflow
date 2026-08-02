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

  it('reports a fixed_time_conflict reason (with the conflicting event) when a fixedTime task collides with an event', () => {
    const tasks = [
      { id: 't7', title: 'Standup prep', isCompleted: false, estimatedHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '09:00' },
    ];
    const events = [{ id: 'ev1', date: today, startTime: '09:00', endTime: '10:00', title: 'Team Standup' }];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events, rules: baseRules, fromDate: today });
    expect(result.overflow).toHaveLength(1);
    expect(result.overflow[0]).toMatchObject({
      taskId: 't7',
      reason: {
        type: 'fixed_time_conflict',
        conflictingItem: { id: 'ev1', type: 'event', label: 'Team Standup', start: '09:00', end: '10:00' },
      },
    });
  });

  it('reports a dependency_blocked reason (naming the blocking task) for a task whose dependency is incomplete', () => {
    const tasks = [
      { id: 't8', title: 'Blocker task', isCompleted: false, estimatedHours: 8, dueDate: today },
      { id: 't9', title: 'Waiting task', isCompleted: false, estimatedHours: 1, dueDate: today, dependsOn: ['t8'] },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    const blocked = result.overflow.find((o) => o.taskId === 't9');
    expect(blocked).toMatchObject({
      reason: { type: 'dependency_blocked', blockingDependencies: [{ id: 't8', title: 'Blocker task' }] },
    });
    expect(result.stats.blockedByDependencies).toBe(1);
  });

  it('reports a no_capacity reason (not fixed_time_conflict) when a non-fixedTime task simply runs out of room', () => {
    const tasks = [
      { id: 't10', title: 'Too much work', isCompleted: false, estimatedHours: 100, dueDate: today, enforceDueDate: true },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    const overflowEntry = result.overflow.find((o) => o.taskId === 't10');
    expect(overflowEntry.reason).toEqual({ type: 'no_capacity' });
  });

  // Regression test: a task with isRecurring=true but no resolvable
  // recurrenceRule/recurrenceString isn't eligible for expandRecurringTasks's
  // per-occurrence expansion, so tasksWithRemaining must use the same
  // resolveTaskRecurrenceRule gate rather than the bare isRecurring flag —
  // otherwise it wrongly skips subtracting this task's already-spent hours
  // (a treatment meant only for tasks actually going through per-occurrence
  // expansion), so a task with lots of historical/locked hours already
  // logged keeps reporting its FULL estimatedHours as still remaining. The
  // allocator then tries to fit that inflated remainder into one
  // single-window day and spuriously reports no_capacity even though the
  // task is nearly done and what's left easily fits.
  it('subtracts already-spent hours for a recurring-flagged task with no resolvable recurrence rule, instead of re-demanding its full estimatedHours', () => {
    const tasks = [
      { id: 't11', title: 'Recurring but unparseable', isRecurring: true, isCompleted: false, estimatedHours: 2, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b11', taskId: 't11', date: '2026-06-30', startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: true },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: { ...baseRules, bufferDays: 1 }, fromDate: today });
    expect(result.overflow.find((o) => o.taskId === 't11')).toBeUndefined();
    const newBlock = result.blocks.find((b) => b.taskId === 't11' && b.id !== 'b11');
    expect(newBlock?.durationHours).toBe(1);
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
