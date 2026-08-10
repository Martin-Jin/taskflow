import { describe, it, expect } from 'vitest';
import { rebalance } from '../../src/algorithms/rebalanceEngine';
import { allocateTasks } from '../../src/algorithms/allocator';
import { computeHorizonCapacity } from '../../src/algorithms/capacityEngine';

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

  it('falls back to later same-day capacity (no conflict reported) when a fixedTime, single-day task collides with an event but the rest of the day is free', () => {
    const tasks = [
      { id: 't7', title: 'Standup prep', isCompleted: false, estimatedHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '09:00' },
    ];
    const events = [{ id: 'ev1', date: today, startTime: '09:00', endTime: '10:00', title: 'Team Standup' }];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events, rules: baseRules, fromDate: today });
    // The 09:00 pinned slot collides with the standup, but the work day runs
    // until 17:00 — a real conflict at the fixed slot only rules out THAT
    // slot, not the rest of the day, so the leftover hour should land
    // elsewhere today instead of being reported as unschedulable.
    expect(result.overflow).toHaveLength(0);
    const block = result.blocks.find((b) => b.taskId === 't7');
    expect(block).toBeTruthy();
    expect(block.startTime).not.toBe('09:00');
  });

  it('schedules a task with an incomplete dependency (no dependency_blocked warning), ordered after the dependency\'s block', () => {
    const tomorrow = '2026-07-02';
    const tasks = [
      { id: 't8', title: 'Blocker task', isCompleted: false, estimatedHours: 2, dueDate: today, enforceDueDate: true },
      { id: 't9', title: 'Waiting task', isCompleted: false, estimatedHours: 1, dueDate: tomorrow, enforceDueDate: true, dependsOn: ['t8'] },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    // Both tasks got placed -- no warning of any kind for either.
    expect(result.overflow.find((o) => o.taskId === 't8')).toBeUndefined();
    expect(result.overflow.find((o) => o.taskId === 't9')).toBeUndefined();
    expect(result.stats.blockedByDependencies).toBe(0);

    const depBlocks = result.blocks.filter((b) => b.taskId === 't8');
    const dependentBlocks = result.blocks.filter((b) => b.taskId === 't9');
    expect(depBlocks.length).toBeGreaterThan(0);
    expect(dependentBlocks.length).toBeGreaterThan(0);
    const depLastEnd = depBlocks.reduce((latest, b) => (b.date + b.endTime > latest ? b.date + b.endTime : latest), '');
    for (const b of dependentBlocks) {
      expect(b.date + b.startTime >= depLastEnd).toBe(true);
    }
  });

  it('reports a dependency_blocked reason for a task whose dependency itself could not be scheduled (capacity overflow)', () => {
    const tasks = [
      // t8 alone demands far more hours than a single day's capacity (8h/day) provides within its own window.
      { id: 't8', title: 'Blocker task', isCompleted: false, estimatedHours: 100, dueDate: today, enforceDueDate: true },
      { id: 't9', title: 'Waiting task', isCompleted: false, estimatedHours: 1, dueDate: today, dependsOn: ['t8'] },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    // The dependency itself overflows with a plain no_capacity reason...
    const depOverflow = result.overflow.find((o) => o.taskId === 't8');
    expect(depOverflow.reason).toEqual({ type: 'no_capacity' });
    // ...and the dependent is ADDITIONALLY flagged as structurally blocked by it (on top of whatever its own
    // allocator overflow reason was), since there's no placed dependency block to order the dependent after.
    const blocked = result.overflow.find((o) => o.taskId === 't9' && o.reason.type === 'dependency_blocked');
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

  // Regression test: maxDailyDeepWorkHours used to be enforced by physically
  // truncating computeDayCapacity's freeIntervals from the FRONT of the day
  // (e.g. a 06:00-23:59 open day with an 8-hour cap became "06:00-14:00
  // only"), deleting every later time-of-day slot from the allocator's view
  // regardless of whether anything had actually been scheduled into it yet.
  // That broke a fixedTime task (e.g. a bedtime "Sleep routine") needing a
  // slot LATER in the day than the cap's cutoff, even on a day with nothing
  // else scheduled — it spuriously reported `no_capacity` even though the
  // real calendar had that time completely free. The cap is now enforced as
  // a running per-day budget as blocks are actually placed (allocator.js's
  // dailyBudgetMins), so it only holds a day back once ITS hours are truly
  // spent, never by pre-deleting unclaimed time-of-day slots.
  it("places a fixedTime task's block late in the day even when maxDailyDeepWorkHours would have truncated that slot under the old front-trimming behavior", () => {
    const tasks = [
      { id: 't12', title: 'Sleep routine', isCompleted: false, estimatedHours: 1, dueDate: today, enforceDueDate: true, fixedTime: '22:00', minChunkHours: 1, maxChunkHours: 1 },
    ];
    const rules = { ...baseRules, workDayStart: '06:00', workDayEnd: '23:59', maxDailyDeepWorkHours: 2 };
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules, fromDate: today });
    expect(result.overflow.find((o) => o.taskId === 't12')).toBeUndefined();
    const block = result.blocks.find((b) => b.taskId === 't12');
    expect(block).toMatchObject({ startTime: '22:00', endTime: '23:00' });
  });

  // A sub-task is otherwise schedulable exactly like a top-level task, but
  // BOTH need a resolvable due date (own or, for a sub-task, an ancestor's)
  // to ever reach the allocator — an undated sub-task under an undated
  // parent is a checklist item, same as an undated top-level task, not
  // schedulable work. See rebalanceEngine.js's `schedulable` filter.
  it('does not schedule an undated sub-task whose parent is also undated', () => {
    const tasks = [
      { id: 'parent', title: 'Undated goal', estimatedHours: 0, parentId: undefined },
      { id: 'sub1', title: 'Undated step', estimatedHours: 2, remainingHours: 2, parentId: 'parent' },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.taskId === 'sub1')).toBe(false);
  });

  it('schedules an undated sub-task once its parent has a due date, using the parent\'s date as urgency pressure', () => {
    const tasks = [
      { id: 'parent', title: 'Dated goal', estimatedHours: 0, dueDate: today },
      { id: 'sub1', title: 'Undated step', estimatedHours: 2, remainingHours: 2, parentId: 'parent' },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: { ...baseRules, bufferDays: 0 }, fromDate: today });
    expect(result.blocks.some((b) => b.taskId === 'sub1')).toBe(true);
  });

  it('schedules a sub-task with its own due date even when its parent is undated', () => {
    const tasks = [
      { id: 'parent', title: 'Undated goal', estimatedHours: 0 },
      { id: 'sub1', title: 'Dated step', estimatedHours: 2, remainingHours: 2, parentId: 'parent', dueDate: today },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: { ...baseRules, bufferDays: 0 }, fromDate: today });
    expect(result.blocks.some((b) => b.taskId === 'sub1')).toBe(true);
  });

  // A container parent (has >=1 sub-task) is never itself scheduled, dated
  // or not — only its leaf sub-tasks ever get calendar blocks.
  it('never schedules a container parent task directly, even with its own due date and remaining hours', () => {
    const tasks = [
      { id: 'parent', title: 'Container goal', estimatedHours: 3, remainingHours: 3, dueDate: today },
      { id: 'sub1', title: 'Step', estimatedHours: 1, remainingHours: 1, parentId: 'parent', dueDate: today },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: { ...baseRules, bufferDays: 0 }, fromDate: today });
    expect(result.blocks.some((b) => b.taskId === 'parent')).toBe(false);
    expect(result.blocks.some((b) => b.taskId === 'sub1')).toBe(true);
  });

  // enforceDueDate on a parent must NOT collapse an undated sub-task's whole
  // window onto that single day — the parent's due date is a soft "must
  // finish everything by this day" deadline for its steps (a window END),
  // never a hard "every step happens on this exact day" constraint. Only a
  // task's OWN enforceDueDate+dueDate collapses its own window.
  it("does not force an undated sub-task onto its enforceDueDate parent's exact day — schedules it earlier within the horizon instead", () => {
    const dueDate = '2026-07-03'; // 2 days into the 1-week horizon from `today`
    const tasks = [
      { id: 'parent', title: 'Hard-deadline goal', estimatedHours: 0, dueDate, enforceDueDate: true },
      { id: 'sub1', title: 'Undated step', estimatedHours: 1, remainingHours: 1, parentId: 'parent' },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: { ...baseRules, bufferDays: 0 }, fromDate: today });
    const block = result.blocks.find((b) => b.taskId === 'sub1');
    expect(block).toBeDefined();
    // Scheduled somewhere at/before the parent's deadline, not necessarily ON it.
    expect(block.date <= dueDate).toBe(true);
  });

  // Regression test for the bug where completing a task early left its
  // still-scheduled FUTURE block sitting on the calendar styled as
  // "completed" — the work on that future day never actually happened, so
  // the stale block must be cleared (freeing capacity) rather than preserved
  // like today's genuinely-completed block is.
  it("clears (does not preserve) a completed non-recurring task's unlocked block dated STRICTLY AFTER today", () => {
    const tomorrow = '2026-07-02';
    const tasks = [
      { id: 'early', title: 'Finished early', isCompleted: true, estimatedHours: 1, dueDate: tomorrow },
    ];
    const existingBlocks = [
      { id: 'b-early', taskId: 'early', date: tomorrow, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    // The stale future block is gone, not preserved as a "completed" block.
    expect(result.blocks.some((b) => b.id === 'b-early')).toBe(false);
    expect(result.stats.blocksCleared).toBe(1);
    // The task is already completed, so it's not re-eligible for allocation
    // either — nothing new gets scheduled for it.
    expect(result.blocks.some((b) => b.taskId === 'early')).toBe(false);
  });

  it("still preserves a completed recurring occurrence's block dated after today if that exact future date is already in completedDates", () => {
    // Edge case per isBlockTaskCompleted's recurring branch: it checks the
    // block's OWN date against completedDates, not "today" — so a future
    // block whose date genuinely IS in completedDates (an occurrence that
    // really was completed) should still be preserved regardless of date,
    // unlike the non-recurring "completed early" case above.
    const tomorrow = '2026-07-02';
    const tasks = [
      {
        id: 'rec-future',
        title: 'Recurring, future occurrence already completed',
        isRecurring: true,
        isCompleted: false,
        completedDates: [tomorrow],
        estimatedHours: 1,
        dueDate: tomorrow,
      },
    ];
    const existingBlocks = [
      { id: 'b-rec-future', taskId: 'rec-future', date: tomorrow, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b-rec-future')).toBe(true);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it('never schedules a task with excludeFromAutoSchedule set, even though it has a resolvable due date and remaining hours', () => {
    const tasks = [
      { id: 'noauto', title: 'Manual only', excludeFromAutoSchedule: true, estimatedHours: 1, dueDate: today },
    ];
    const result = rebalance({ tasks, existingBlocks: [], routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.taskId === 'noauto')).toBe(false);
  });

  it('clears an excluded task\'s existing unlocked block instead of leaving it in place', () => {
    const tasks = [
      { id: 'noauto2', title: 'Newly excluded', excludeFromAutoSchedule: true, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b-noauto2', taskId: 'noauto2', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.blocks.some((b) => b.id === 'b-noauto2')).toBe(false);
  });
});

// Coverage for `todayOnly` (used by SchedulerContext.completeTask so
// finishing a task early re-plans the freed-up slot into the REST of today,
// without ever touching a future day) — see rebalanceEngine.js's own doc
// comment on the option for the exact contract.
describe('rebalance: todayOnly scoping', () => {
  it("moves another schedulable task into a slot freed by completing an earlier-today task, and leaves a FUTURE day's block completely untouched", () => {
    const tomorrow = '2026-07-02';
    const tasks = [
      // Already completed — its old 09:00-10:00 slot today should be freed.
      { id: 'done', title: 'Finished early', isCompleted: true, estimatedHours: 1, dueDate: today },
      // Still has remaining hours and is eligible to claim the freed slot.
      { id: 'other', title: 'Other task', isCompleted: false, estimatedHours: 1, remainingHours: 1, dueDate: today, enforceDueDate: true },
      // A separate task with a block on a FUTURE day — must not be touched.
      { id: 'future', title: 'Future task', isCompleted: false, estimatedHours: 1, remainingHours: 1, dueDate: tomorrow },
    ];
    const existingBlocks = [
      // Completed task's block preserved as historical record (isBlockTaskCompleted).
      { id: 'b-done', taskId: 'done', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
      // Unlocked, unfinished future-day block that must survive byte-for-byte.
      { id: 'b-future', taskId: 'future', date: tomorrow, startTime: '11:00', endTime: '12:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({
      tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today, todayOnly: true,
    });

    // The other task got a new block placed today (its own remaining hour).
    const otherBlock = result.blocks.find((b) => b.taskId === 'other');
    expect(otherBlock).toBeTruthy();
    expect(otherBlock.date).toBe(today);

    // The future block is byte-for-byte unchanged (same object even).
    const futureBlock = result.blocks.find((b) => b.id === 'b-future');
    expect(futureBlock).toEqual(existingBlocks[1]);

    // The completed task's historical block for today is preserved too.
    expect(result.blocks.some((b) => b.id === 'b-done')).toBe(true);
  });

  it('does not clear or reschedule a stale, unfinished, unlocked block on a day AFTER today when todayOnly is set', () => {
    const tomorrow = '2026-07-02';
    const tasks = [
      { id: 'later', title: 'Not due yet', isCompleted: false, estimatedHours: 1, remainingHours: 1, dueDate: tomorrow },
    ];
    const existingBlocks = [
      { id: 'b-later', taskId: 'later', date: tomorrow, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({
      tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today, todayOnly: true,
    });
    // A full-horizon rebalance would normally be free to clear/move this
    // (it's unlocked and unfinished) — todayOnly must leave it alone.
    expect(result.blocks).toEqual(existingBlocks);
    expect(result.stats.blocksCleared).toBe(0);
  });

  it('does not touch a future day even for the manual (non-todayOnly) call path, confirming the option is additive', () => {
    // Sanity check: omitting todayOnly keeps full-horizon behavior — a
    // regression here would mean todayOnly's changes leaked into the default path.
    const tasks = [
      { id: 't', title: 'Not done', isCompleted: false, estimatedHours: 1, dueDate: today },
    ];
    const existingBlocks = [
      { id: 'b', taskId: 't', date: today, startTime: '09:00', endTime: '10:00', durationHours: 1, isLocked: false },
    ];
    const result = rebalance({ tasks, existingBlocks, routines: [], events: [], rules: baseRules, fromDate: today });
    expect(result.stats.blocksCleared).toBe(1);
  });
});

// Regression coverage for a false "no free time left" report on a recurring,
// fixedTime task (e.g. "Piano" at a fixed practice time, or "Practice
// questions" today) whose per-occurrence virtual task collapses its window to
// a single day (rebalanceEngine's expandRecurringTasks sets enforceDueDate)
// AND whose fixed time-of-day slot isn't available that day — either because
// nowClamp has pushed the work day's start past it (the slot already "came
// and went" earlier today) or because it simply falls outside the work day.
// A single-day window means fixedTime's normal "just try again tomorrow"
// fallback (see placeFixedTimeInDay's doc comment) has no other day to use,
// so before this fix the task's whole remaining duration was reported as
// no_capacity even on a day with hours of otherwise-visible free time. These
// tests exercise allocateTasks directly (rather than nowClamp's real
// wall-clock gating in rebalance(), which would make a test
// depend on what time it's actually run) by building a capacity map whose
// free interval simply starts after the fixed time, exactly like nowClamp
// would produce.
describe('allocateTasks: fixedTime + single-day window fallback', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '22:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('falls back to placing a fixedTime task later the same day when its pinned slot has already passed (nowClamp-style)', () => {
    // Simulates "now" being 16:30 on a recurring task ("Practice questions")
    // whose fixed practice time was 09:00 — long gone — but the rest of the
    // day (16:30-22:00) is completely free.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], events: [], blocks: [], rules,
      nowClamp: { date: '2026-07-01', minutes: 16 * 60 + 30 },
    });
    const task = {
      id: 'occ1', title: 'Practice questions', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    // Placed somewhere in the still-open remainder of the day, not at the
    // (now unavailable) 09:00 fixed time.
    expect(blocks[0].startTime >= '16:30').toBe(true);
    expect(blocks[0].durationHours).toBe(1);
  });

  it('falls back to later same-day capacity (no conflict reported) when a real event occupies the fixed slot but the rest of the day is free', () => {
    // A genuine collision at the pinned slot only rules out THAT slot — it
    // says nothing about the rest of the day. With hours of open capacity
    // still left (10:00-22:00 here), the task should relocate there instead
    // of being reported as unschedulable while the calendar is visibly free.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Piano lesson' }],
    });
    const task = {
      id: 'occ2', title: 'Piano', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startTime >= '10:00').toBe(true);
    expect(blocks[0].durationHours).toBe(1);
  });

  it('still reports fixed_time_conflict when a real event occupies the fixed slot AND the rest of the day has no room left', () => {
    // Genuine conflict at the pinned slot, and nothing else free that day —
    // this is the one case that should still surface as unschedulable.
    const tightRules = { ...rules, workDayStart: '09:00', workDayEnd: '10:00' };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules: tightRules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Piano lesson' }],
    });
    const task = {
      id: 'occ2', title: 'Piano', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00', isRecurring: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, tightRules, '2026-07-01');
    expect(blocks).toHaveLength(0);
    expect(overflow).toEqual([{
      taskId: 'occ2',
      unplacedHours: 1,
      reason: {
        type: 'fixed_time_conflict',
        conflictingItem: { id: 'ev1', type: 'event', label: 'Piano lesson', start: '09:00', end: '10:00' },
      },
      dueDate: '2026-07-01',
    }]);
  });

  it('does NOT apply the same-day fallback to a normal multi-day fixedTime task (it still just tries again on a later day)', () => {
    // Sanity check that the fallback is scoped to single-day windows only —
    // a normal fixedTime task with several days of runway should behave
    // exactly as before: skip a day whose fixed slot is blocked and place on
    // a later day instead, never relocating within the blocked day itself.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Meeting' }],
    });
    const task = {
      id: 't13', title: 'Multi-day fixedTime', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-03', fixedTime: '09:00',
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    // Placed on 07-02 (or 07-03) at the fixed time, NOT relocated to later on 07-01.
    expect(blocks[0].date).not.toBe('2026-07-01');
    expect(blocks[0].startTime).toBe('09:00');
  });
});

describe('allocateTasks: last-resort splitting when no continuous block fits', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '18:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('splits a task across several small non-contiguous gaps when no single gap can hold the full remaining duration', () => {
    // Three 1-hour meetings carve the day into four 45-min-or-shorter gaps —
    // none individually big enough for a continuous 1.75-hour block, but they
    // sum to well over that. A continuous placement is genuinely impossible,
    // so the task should still fully place by splitting across several of
    // these gaps, as long as it doesn't exceed its chunk-count budget
    // (round(105/30) = 4 chunks — see maxChunksFor in allocator.js) and no
    // individual chunk drops below the 5-minute floor (MIN_CHUNK_HOURS).
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:45', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev2', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev3', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    // Free gaps: 09:00-09:45 (45m), 10:45-11:15 (30m), 12:15-12:45 (30m), 13:45-18:00 (4h15m).
    // 1.75h is fully absorbed by the first three gaps (0.75+0.5+0.5), so this
    // never even needs to reach into the wide-open fourth gap.
    const task = {
      id: 'tsplit', title: 'Deep work', estimatedHours: 1.75, remainingHours: 1.75,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(1.75, 5);
    expect(blocks.length).toBeLessThanOrEqual(4);
  });

  it('fully places a task even when its chunks must go below 30 minutes, as long as the chunk-count cap and 5-minute floor are respected', () => {
    // Same fragmented day as above. A 2-hour task's chunk budget is
    // round(120/30) = 4 -- exactly enough to use all three fragmented gaps
    // (0.75+0.5+0.5 = 1.75h) plus a fourth chunk from the wide-open remainder
    // for the last 0.25h. Unlike the old flat 30-minute floor (which used to
    // force this 0.25h into overflow), a sub-30-minute final chunk is fine
    // here since it's still >= the 5-minute floor and the chunk count is
    // within budget.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:45', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev2', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev3', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    const task = {
      id: 'tsplit2', title: 'Deep work', estimatedHours: 2, remainingHours: 2,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(2, 5);
    expect(blocks.length).toBeLessThanOrEqual(4);
  });

  it('prefers a single later continuous block over exhausting the chunk-count cap on small early gaps', () => {
    // Five small/medium gaps this time -- 09:00-09:20 (20m), 09:45-09:55
    // (10m), 10:45-11:15 (30m), 12:15-12:45 (30m), then a wide-open
    // 13:45-18:00. A 1-hour task's chunk budget is round(60/30) = 2. Plain
    // front-to-back first-fit would claim the FIRST two gaps it reaches (20m
    // + 10m = 30m) and then have no chunks left for the remaining 30
    // minutes, even though the calendar visibly still has plenty of free
    // time later that day. The scheduler's whole-block lookahead (see
    // placeHoursInDay in allocator.js) instead recognizes that its last
    // available chunk should skip the small 09:45 gap and take the entire
    // 40-minute remainder from the wide-open 13:45 block in one continuous
    // placement, fully scheduling the task with no overflow.
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules,
      events: [
        { id: 'ev1', date: '2026-07-01', startTime: '09:20', endTime: '09:45' },
        { id: 'ev2', date: '2026-07-01', startTime: '09:55', endTime: '10:45', title: 'Meeting A' },
        { id: 'ev3', date: '2026-07-01', startTime: '11:15', endTime: '12:15', title: 'Meeting B' },
        { id: 'ev4', date: '2026-07-01', startTime: '12:45', endTime: '13:45', title: 'Meeting C' },
      ],
    });
    const task = {
      id: 'tcap', title: 'Deep work', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(blocks.length).toBeLessThanOrEqual(2);
    const totalHours = blocks.reduce((sum, b) => sum + b.durationHours, 0);
    expect(totalHours).toBeCloseTo(1, 5);
    expect(overflow).toHaveLength(0);
    expect(blocks.some((b) => b.startTime === '13:45' && Math.abs(b.durationHours - 40 / 60) < 1e-9)).toBe(true);
  });

  it('still prefers a single continuous block when one is available, and does not fragment unnecessarily', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules, events: [],
    });
    const task = {
      id: 'tcontig', title: 'Deep work', estimatedHours: 2, remainingHours: 2,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { blocks, overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].durationHours).toBe(2);
  });

  it('reports genuine no_capacity when the day truly cannot fit the remaining hours even split', () => {
    const tightRules = { ...rules, workDayStart: '09:00', workDayEnd: '10:00' };
    const capacityMap = computeHorizonCapacity('2026-07-01', 1, {
      routines: [], blocks: [], rules: tightRules, events: [],
    });
    const task = {
      id: 'tnone', title: 'Deep work', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-07-01', enforceDueDate: true,
    };
    const { overflow } = allocateTasks([task], capacityMap, tightRules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('no_capacity');
    expect(overflow[0].unplacedHours).toBeCloseTo(4, 5);
  });
});

// Regression coverage: horizonEnd (the last date in capacityMap, e.g. "3
// weeks out" by default) is a display/computation window, not the task's
// real deadline. A task whose resolved due date is beyond horizonEnd still
// has genuine runway past the visible horizon, so running out of capacity
// WITHIN the horizon must not be reported as a false 'no_capacity' conflict
// — see allocator.js's final overflow push in allocateTasks.
describe('allocateTasks: no false no_capacity overflow when due date is beyond the horizon', () => {
  const rules = { workDayStart: '09:00', workDayEnd: '10:00', maxDailyDeepWorkHours: 8, minGapBetweenBlocksMins: 0, horizonWeeks: 1, bufferDays: 0 };

  it('does not report no_capacity for a task due beyond the horizon even though it cannot fit within the visible window', () => {
    // Only a 3-day horizon (1 hour/day = 3 hours total capacity), but the
    // task is due well beyond it and needs more than those 3 hours.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], events: [], blocks: [], rules,
    });
    const task = {
      id: 'tfar', title: 'Long-runway task', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-08-15', // far beyond the 2026-07-01..2026-07-03 horizon
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(0);
  });

  it('still reports no_capacity for a task due WITHIN the horizon that genuinely cannot fit', () => {
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], events: [], blocks: [], rules,
    });
    const task = {
      id: 'tnear', title: 'Due within horizon', estimatedHours: 5, remainingHours: 5,
      dueDate: '2026-07-03', enforceDueDate: true,
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('no_capacity');
  });

  it('still reports fixed_time_conflict (untouched by the horizon suppression) for a task due WITHIN the horizon whose pinned slot is genuinely occupied', () => {
    // Sanity check that the new due-date-vs-horizon suppression is scoped to
    // the no_capacity case only, per the fix's own requirement — a real
    // fixed_time_conflict within the horizon must keep reporting exactly as
    // before.
    const capacityMap = computeHorizonCapacity('2026-07-01', 3, {
      routines: [], blocks: [], rules,
      events: [{ id: 'ev1', date: '2026-07-01', startTime: '09:00', endTime: '10:00', title: 'Meeting' }],
    });
    const task = {
      id: 'tfixed', title: 'Fixed, due within horizon', estimatedHours: 1, remainingHours: 1,
      dueDate: '2026-07-01', enforceDueDate: true, fixedTime: '09:00',
    };
    const { overflow } = allocateTasks([task], capacityMap, rules, '2026-07-01');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].reason.type).toBe('fixed_time_conflict');
  });
});
